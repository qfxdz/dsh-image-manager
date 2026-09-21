/**
 * dsh-image-manager —— Host 半边。
 *
 * 解决两个问题：
 *   1. 会话里的图片只增不减（每轮请求都会把历史图片重新塞进请求体），
 *      迟早撞上网关 / vLLM 的「At most N image(s) may be provided in one prompt」。
 *   2. 撞上之后没有选择权：内置的 image-offload 只会永久丢掉最旧的图片。
 *
 * 本插件把「每个会话最多发几张图」变成会话级设置，并让模型/用户自己挑选
 * 要发送哪几张（其余图片在请求里降级为文字占位符，但**不**从会话里丢失，
 * 随时可以恢复）。
 *
 * 落盘方式：复用 Harness 已登记的 log-only 事件类型 `image/offload`。
 * 这是下游插件唯一能安全使用的、可持久化且能影响模型请求的事件类型：
 *  - 它在 KNOWN_SESSION_EVENT_TYPES 白名单里，会话重启后仍可解析；
 *  - 它已经带有一套「把图片标记为 offloaded」的投影机制。
 * 本插件接管（禁用内置 @deepseek-ai/dsh-compaction-image-offload）该类型，
 * 把事件 data 解释为「完整策略快照」而不是「追加式丢弃」，
 * 因此策略可逆：选择、恢复、改上限都不会真的丢掉图片。
 * 同时兼容内置插件历史写入的 `{ targets: [...] }` 增量格式。
 *
 * 事件 data（v2）：
 *   { v: 2, maxImages, pinned: [attachmentId...], dropped: [attachmentId...],
 *     labels: { [attachmentId]: string } }
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const name = 'image-manager';

/** 硬依赖：没有这两个服务插件无法工作。 */
export const inject = ['sessions', 'tools', 'attachments'];

/** 复用白名单事件类型（见文件头注释）。 */
const POLICY_EVENT = 'image/offload';

const DEFAULT_MAX_IMAGES = 8;
const MIN_MAX_IMAGES = 1;
const MAX_MAX_IMAGES = 256;
const API_PREFIX = '/dsh-image-manager';
/**
 * Host 半边接口版本。浏览器半边是每次刷新从磁盘读的，而 Host 只在进程启动时加载，
 * 两者可能版本不一致；客户端据此给出「请重启 dsh」的明确提示而不是裸的 NOT_FOUND。
 */
const API_VERSION = 2;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isIndex = (value) => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);

/** 一次「图片出现」的稳定键：同一张图可以出现在多个位置。 */
const occurrenceKey = (seq, index) => `${seq}:${index}`;

function clampMax(value, fallback = DEFAULT_MAX_IMAGES) {
	if (!Number.isSafeInteger(value)) return fallback;
	if (value < MIN_MAX_IMAGES) return MIN_MAX_IMAGES;
	if (value > MAX_MAX_IMAGES) return MAX_MAX_IMAGES;
	return value;
}

/**
 * 归一化后的会话策略：
 *   inherit=true  → 跟着全局默认走（maxImages 只是上一次解析出来的值，会被重算）
 *   inherit=false → 会话自己设了上限，覆盖全局
 * maxImages 始终是「写这条事件时的生效值」，因此投影只依赖会话日志，重放是确定的。
 */
function defaultPolicy(maxImages = DEFAULT_MAX_IMAGES) {
	return {
		v: 2,
		inherit: true,
		maxImages: clampMax(maxImages),
		pinned: [],
		dropped: [],
		labels: {},
	};
}

/** 把任意事件 data 归一化成一份合法策略快照；非法输入回落到默认值。 */
function normalizePolicy(data, fallback) {
	const base = fallback ?? defaultPolicy();
	if (!isRecord(data)) return { ...base };
	const pinned = Array.isArray(data.pinned) ? data.pinned.filter((id) => typeof id === 'string') : base.pinned;
	const dropped = Array.isArray(data.dropped) ? data.dropped.filter((id) => typeof id === 'string') : base.dropped;
	const labels = {};
	const source = isRecord(data.labels) ? data.labels : base.labels;
	for (const [key, value] of Object.entries(source ?? {})) {
		if (typeof value === 'string' && value.length > 0) labels[key] = value;
	}
	return {
		v: 2,
		inherit: typeof data.inherit === 'boolean' ? data.inherit : base.inherit,
		maxImages: clampMax(data.maxImages, base.maxImages),
		// 去重且保序
		pinned: [...new Set(pinned)],
		dropped: [...new Set(dropped)],
		labels,
	};
}

/** 会话的生效上限：会话覆盖优先，否则用全局默认。 */
function effectiveMax(policy, globalMax) {
	return policy.inherit ? clampMax(globalMax) : clampMax(policy.maxImages);
}


/** 去掉 `offloaded` 标记（恢复一张图）；返回原对象表示无需改动。 */
function restoreBlock(block) {
	if (block.offloaded !== true) return block;
	const next = { ...block };
	delete next.offloaded;
	return next;
}

// ---------------------------------------------------------------------------
// 图片位置收集 / 决策
// ---------------------------------------------------------------------------

/**
 * 按模型请求顺序收集所有图片位置。
 * @param {(seq: number) => object | undefined} messageAt - 取某个 surface seq 上「投影后」的消息。
 * @param {number[]} nodes - 当前 surface 的 seq 列表（升序）。
 */
function collectOccurrences(nodes, messageAt) {
	const occurrences = [];
	for (const seq of nodes) {
		const message = messageAt(seq);
		if (message === undefined) continue;
		let imageIndex = 0;
		const visit = (blocks) => {
			for (const block of blocks ?? []) {
				if (block?.type === 'image') {
					occurrences.push({
						seq,
						index: imageIndex,
						key: occurrenceKey(seq, imageIndex),
						id: block.attachment?.attachmentId,
						attachment: block.attachment,
					});
					imageIndex += 1;
				} else if (block?.type === 'tool-result') {
					visit(block.content);
				}
			}
		};
		visit(message.content);
	}
	return occurrences;
}

/**
 * 决策：给定策略与全部图片位置，返回本次要「保留在请求里」的位置键集合。
 * 规则（保守、可预测）：
 *   - dropped 里的图片永不出现在请求中；
 *   - 命中 pinned 的图片优先占位（超出上限时保留其中最新的若干张）；
 *   - 剩余名额给最新出现的图片（保新弃旧）。
 */
function decideKeep(occurrences, policy) {
	const dropped = new Set(policy.dropped);
	const candidates = occurrences.filter((item) => item.id !== undefined && !dropped.has(item.id));
	const keep = new Set();
	const max = policy.maxImages;

	if (policy.pinned.length > 0) {
		const pinned = new Set(policy.pinned);
		const chosen = candidates.filter((item) => pinned.has(item.id));
		for (const item of chosen.slice(-max)) keep.add(item.key);
		const room = max - keep.size;
		if (room > 0) {
			const rest = candidates.filter((item) => !pinned.has(item.id));
			for (const item of rest.slice(-room)) keep.add(item.key);
		}
	} else {
		for (const item of candidates.slice(-max)) keep.add(item.key);
	}
	return keep;
}

/** 在一条消息上按 keep 集合设置 / 清除 offloaded 标记（纯函数，不修改入参）。 */
function applyMarks(message, seq, keep) {
	let imageIndex = 0;
	let changed = false;
	const visit = (blocks) => {
		let next = null;
		for (const [position, block] of (blocks ?? []).entries()) {
			let projected = block;
			if (block?.type === 'image') {
				const shouldKeep = keep.has(occurrenceKey(seq, imageIndex));
				if (shouldKeep) projected = restoreBlock(block);
				else if (block.offloaded !== true) projected = { ...block, offloaded: true };
				imageIndex += 1;
			} else if (block?.type === 'tool-result') {
				const content = visit(block.content);
				if (content !== block.content) projected = { ...block, content };
			}
			if (projected !== block) {
				next ??= (blocks ?? []).slice(0, position);
				changed = true;
			}
			next?.push(projected);
		}
		return next ?? blocks ?? [];
	};
	const content = visit(message.content);
	return changed ? { ...message, content } : message;
}

/** 内置插件历史格式：只标注给定位置。 */
function applyLegacyTargets(targets, context) {
	const messages = new Map();
	const nodes = new Set(context.nodes);
	for (const target of targets) {
		if (!isRecord(target) || !isIndex(target.seq) || !Array.isArray(target.imageIndexes)) continue;
		const seq = target.seq;
		if (!nodes.has(seq)) continue;
		const source = context.events[seq - context.baseSeq];
		if (source?.type !== 'user/message' && source?.type !== 'tool/result') continue;
		const message = context.messages.get(seq) ?? (source.type === 'user/message' ? source.data : source.data.message);
		const keep = new Set();
		const targeted = new Set(target.imageIndexes.filter(isIndex));
		let imageIndex = 0;
		const visit = (blocks) => {
			for (const block of blocks ?? []) {
				if (block?.type === 'image') {
					if (!targeted.has(imageIndex)) keep.add(occurrenceKey(seq, imageIndex));
					imageIndex += 1;
				} else if (block?.type === 'tool-result') visit(block.content);
			}
		};
		visit(message?.content);
		messages.set(seq, applyMarks(message, seq, keep));
	}
	return messages;
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

/**
 * @param {object} ctx - cordis Host context。
 */
export function apply(ctx) {
	/** 每个会话一份策略缓存：{ seq, policy, signature }。 */
	const cache = new WeakMap();
	/** 每次模型请求失败后的恢复次数（防止无限重试）。 */
	const recoveryAttempts = new WeakMap();

	const logger = ctx.logger;

	// -- 附件服务（只用于预览）-------------------------------------------------
	//
	// 缩略图/大图预览要读原始字节，必须用 ctx.attachments。cordis 对未声明的服务
	// 取属性会直接抛（cannot get property "attachments" without inject），
	// 所以 `attachments` 写在 export const inject 里，apply 运行时它一定就绪。
	let attachments = ctx.attachments;
	// 兜底：插件重载导致服务句柄被替换时跟着换新。
	ctx.inject?.(['attachments'], (scopedCtx) => {
		attachments = scopedCtx.attachments ?? attachments;
	});

	// -- 全局默认设置（dsh 没有全局设置文件以外的会话级设置机制） --------------
	//
	// 全局默认存在 <DSH_HOME>/image-manager.json，与会话日志解耦：
	// 会话日志只记录「写入那一刻的生效值 + 是否跟随全局」，全局改动时由本插件
	// 给所有仍处于「跟随全局」的会话补写一条新事件，投影因此始终是确定的。

	const settingsFile = join(
		ctx.get?.('profileContext')?.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'),
		'image-manager.json',
	);

	let settingsCache = { mtimeMs: -1, maxImages: DEFAULT_MAX_IMAGES };

	/** 读取全局默认（按 mtime 缓存，手工编辑文件也能生效）。 */
	function readGlobalMax() {
		try {
			const stat = statSync(settingsFile);
			if (stat.mtimeMs !== settingsCache.mtimeMs) {
				const parsed = JSON.parse(readFileSync(settingsFile, 'utf8'));
				settingsCache = {
					mtimeMs: stat.mtimeMs,
					maxImages: isRecord(parsed) ? clampMax(parsed.maxImages) : DEFAULT_MAX_IMAGES,
				};
			}
		} catch {
			// 文件不存在/不可读 → 用内置默认
		}
		return settingsCache.maxImages;
	}

	/** 写入全局默认，并让所有「跟随全局」的会话立刻按新值对账。 */
	function writeGlobalMax(value) {
		const maxImages = clampMax(value);
		try {
			mkdirSync(dirname(settingsFile), { recursive: true });
			const tmp = `${settingsFile}.tmp`;
			writeFileSync(tmp, `${JSON.stringify({ maxImages }, null, 2)}\n`, 'utf8');
			renameSync(tmp, settingsFile);
			settingsCache = { mtimeMs: statSync(settingsFile).mtimeMs, maxImages };
		} catch (error) {
			logger?.warn?.(`image-manager: cannot persist ${settingsFile}: ${error?.message ?? error}`);
		}
		for (const session of liveSessions()) {
			try {
				const policy = readPolicy(session);
				if (policy.inherit) commit(session, policy, { force: true });
			} catch (error) {
				logger?.warn?.(`image-manager: re-enforce failed: ${error?.message ?? error}`);
			}
		}
		return maxImages;
	}

	function liveSessions() {
		try {
			return ctx.sessions.list?.() ?? [];
		} catch {
			return [];
		}
	}

	// -- 读取 / 写入会话策略 --------------------------------------------------

	function sessionOf(agent) {
		return agent?.session;
	}

	function forEachEvent(session, visit) {
		const total = typeof session.seq === 'number' ? session.seq : 0;
		if (typeof session.snapshotEvents === 'function') {
			let events;
			try {
				events = session.snapshotEvents();
			} catch {
				events = undefined;
			}
			if (Array.isArray(events)) {
				for (const event of events) visit(event);
				return;
			}
		}
		for (let seq = 0; seq < total; seq += 1) {
			let event;
			try {
				event = session.eventAt(seq);
			} catch {
				event = undefined;
			}
			if (event !== undefined) visit(event);
		}
	}

	/** 读取会话当前策略（增量扫描 + 缓存）。 */
	function readPolicy(session) {
		const cached = cache.get(session);
		const total = typeof session.seq === 'number' ? session.seq : 0;
		if (cached !== undefined && cached.seq === total) return cached.policy;

		let policy = cached?.policy ?? defaultPolicy(readGlobalMax());
		if (cached === undefined || cached.seq > total) policy = defaultPolicy(readGlobalMax());
		const from = cached !== undefined && cached.seq <= total ? cached.seq : 0;

		forEachEvent(session, (event) => {
			if (event?.type !== POLICY_EVENT) return;
			if (isRecord(event.data) && event.data.v === 2) policy = normalizePolicy(event.data, policy);
			else if (isRecord(event.data) && Array.isArray(event.data.targets)) policy = legacyPolicy(policy, event.data.targets);
		});

		cache.set(session, { seq: total, policy, signature: cached?.signature ?? null });
		return policy;
	}

	/** 把内置插件的增量 targets 吸收进策略（等价于永久 dropped）。 */
	function legacyPolicy(policy, targets) {
		const dropped = new Set(policy.dropped);
		for (const target of targets) {
			if (!isRecord(target)) continue;
			// 历史格式只有位置、没有 attachmentId，无法据此改名；保留原策略。
		}
		return { ...policy, dropped: [...dropped] };
	}

	/** 把一份策略写成一条事件，并让缓存与该事件对齐（避免紧接着的 pre-step 重复写入）。 */
	function writePolicy(session, policy, planned) {
		session.append(POLICY_EVENT, {
			v: 2,
			inherit: policy.inherit === true,
			maxImages: policy.inherit === true ? clampMax(readGlobalMax()) : clampMax(policy.maxImages),
			pinned: [...policy.pinned],
			dropped: [...policy.dropped],
			labels: { ...policy.labels },
			// ⚠️ 必须带上 targets：`@deepseek-ai/dsh-token-meter` 自己也在折叠
			// image/offload 事件，并且无条件执行 `event.data.targets.map(...)`；
			// 缺了它就会抛 "Cannot read properties of undefined (reading 'map')"，
			// 连带把上下文计费 / 自动压缩 / `/compact` 全部弄挂。
			// 语义：该 meter 只做「累加式标记」，所以这里给的是**当前应标记为
			// offloaded 的全部出现位置**（cumulative），而不是本次增量。
			targets: offloadTargets(planned),
		});
		cache.set(session, { seq: typeof session.seq === 'number' ? session.seq : 0, policy, signature: null });
		return policy;
	}

	/**
	 * 把「不该发送」的图片位置整理成内置 image/offload 的 targets 形状。
	 * @param planned - plan()/commit() 的结果（含 occurrences 与 keep）。
	 * @returns [{ seq, imageIndexes }]，按 seq 升序、indexes 升序；没有则 []。
	 */
	function offloadTargets(planned) {
		const bySeq = new Map();
		for (const item of planned?.occurrences ?? []) {
			if (planned.keep.has(item.key)) continue;
			const set = bySeq.get(item.seq) ?? new Set();
			set.add(item.index);
			bySeq.set(item.seq, set);
		}
		return [...bySeq.entries()]
			.sort((left, right) => left[0] - right[0])
			.map(([seq, indexes]) => ({ seq, imageIndexes: [...indexes].sort((left, right) => left - right) }));
	}

	/** 从会话日志里取出全部图片位置（含 attachment 引用）。 */
	function imagesOf(session, policy) {
		const messageAt = (seq) => {
			const event = session.eventAt(seq);
			if (event === undefined || event === null) return undefined;
			if (event.type !== 'user/message' && event.type !== 'tool/result') return undefined;
			try {
				return session.deriveEventMessage(event);
			} catch {
				return undefined;
			}
		};
		const nodes = [...(session.surface?.nodes ?? [])];
		return { nodes, occurrences: collectOccurrences(nodes, messageAt) };
	}

	/** 计算一份策略在当前会话上的结果（不写事件）。 */
	function plan(session, policy) {
		const resolved = effectiveMax(policy, readGlobalMax());
		const { occurrences } = imagesOf(session, policy);
		const keep = decideKeep(occurrences, { ...policy, maxImages: resolved });
		const offloaded = occurrences.filter((item) => !keep.has(item.key)).length;
		const signature = JSON.stringify({
			inherit: policy.inherit === true,
			resolved,
			pinned: policy.pinned.filter((id) => occurrences.some((item) => item.id === id)),
			dropped: policy.dropped,
			labels: Object.keys(policy.labels).length,
			images: occurrences.map((item) => item.id ?? '?'),
		});
		return { policy, occurrences, keep, offloaded, signature };
	}

	/**
	 * 落盘一份策略：需要（或 force）时写一条事件并缓存结果签名。
	 * pre-step 与工具/接口共用它，保证同一状态只写一条事件。
	 */
	function commit(session, policy, { force = false } = {}) {
		const planned = plan(session, policy);
		const cached = cache.get(session);
		const needed = planned.offloaded > 0 || policy.pinned.length > 0 || policy.dropped.length > 0;
		if (!force && (!needed || cached?.signature === planned.signature)) {
			return { ...planned, changed: false };
		}
		writePolicy(session, policy, planned);
		cache.set(session, {
			seq: typeof session.seq === 'number' ? session.seq : 0,
			policy,
			signature: planned.signature,
		});
		return { ...planned, changed: true };
	}

	/** pre-step：策略或图片集合变化时对账。 */
	function enforce(session) {
		return commit(session, readPolicy(session));
	}

	// -- 消息投影：解释 image/offload 事件 ------------------------------------

	const projection = {
		type: POLICY_EVENT,
		project(event, context) {
			const data = event?.data;
			// v2 策略快照优先：它也带 targets（给 token meter 用），但语义是「完整快照」。
			if (isRecord(data) && data.v === 2) {
				/* fallthrough to snapshot handling below */
			} else if (isRecord(data) && Array.isArray(data.targets)) {
				return applyLegacyTargets(data.targets, context);
			}

			const policy = normalizePolicy(data);
			const messageAt = (seq) => {
				const cached = context.messages.get(seq);
				if (cached !== undefined) return cached;
				const source = context.events[seq - context.baseSeq];
				if (source === undefined || source === null) return undefined;
				if (source.type !== 'user/message' && source.type !== 'tool/result') return undefined;
				return source.type === 'user/message' ? source.data : source.data.message;
			};
			const occurrences = collectOccurrences([...context.nodes], messageAt);
			const keep = decideKeep(occurrences, policy);

			const messages = new Map();
			const touched = new Set(occurrences.map((item) => item.seq));
			for (const seq of touched) {
				const message = messageAt(seq);
				if (message === undefined) continue;
				messages.set(seq, applyMarks(message, seq, keep));
			}
			return messages;
		},
	};

	try {
		ctx.sessions.registerMessageProjection(projection);
	} catch (error) {
		logger?.warn?.(
			`image-manager: cannot own the "${POLICY_EVENT}" projection (${error?.message ?? error}); ` +
				'disable @deepseek-ai/dsh-compaction-image-offload so this plugin can manage image selection.',
		);
	}

	// -- 请求前对账：策略或图片集合变化时写一条新的策略事件 --------------------

	ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
		if (signal?.aborted !== true) {
			try {
				if (sessionOf(agent) !== undefined) enforce(sessionOf(agent));
			} catch (error) {
				logger?.warn?.(`image-manager: pre-step reconcile failed: ${error?.message ?? error}`);
			}
		}
		return next();
	});

	ctx.on('agent/status', ({ agent, status }) => {
		if (status === 'idle' && agent !== undefined) recoveryAttempts.delete(agent);
	});

	// -- 兜底：网关/适配器自己判定超限时，按同样规则再收一轮 --------------------

	ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
		try {
			if (failure?.code !== 'IMAGE_OFFLOAD_REQUIRED' || signal?.aborted === true) return next();
			const session = sessionOf(agent);
			if (session === undefined) return next();
			const attempts = recoveryAttempts.get(agent) ?? 0;
			if (attempts >= 3) return next();

			const policy = readPolicy(session);
			const { occurrences } = imagesOf(session, policy);
			const keep = decideKeep(occurrences, policy);
			const excess = occurrences.length - keep.size;
			const need = Number.isSafeInteger(failure.offloadImages) ? failure.offloadImages : 1;
			if (excess >= need && excess > 0) {
				// 已经比适配器要求的更严格，却仍被拒绝：说明不是张数问题，交给下游。
				return next();
			}
			const nextMax = clampMax(keep.size - Math.max(1, need));
			if (nextMax >= policy.maxImages) return next();
			recoveryAttempts.set(agent, attempts + 1);
			commit(session, { ...policy, maxImages: nextMax }, { force: true });
			return { kind: 'retry' };
		} catch (error) {
			logger?.warn?.(`image-manager: request-error recovery failed: ${error?.message ?? error}`);
			return next();
		}
	});

	// -- 模型工具 ------------------------------------------------------------

	const textOutput = {
		schema: { type: 'string' },
		render: (_args, value) => [{ type: 'text', text: String(value) }],
	};

	function describe(session) {
		const policy = readPolicy(session);
		const resolved = effectiveMax(policy, readGlobalMax());
		const { occurrences } = imagesOf(session, policy);
		const keep = decideKeep(occurrences, { ...policy, maxImages: resolved });
		// 同一张图可能重复出现，按 attachmentId 聚合，位置取最后一次。
		const byId = new Map();
		occurrences.forEach((item, order) => {
			if (item.id === undefined) return;
			const entry = byId.get(item.id) ?? {
				id: item.id,
				label: policy.labels[item.id],
				attachment: item.attachment,
				sent: false,
				order,
			};
			entry.sent = entry.sent || keep.has(item.key);
			entry.order = order;
			byId.set(item.id, entry);
		});
		const images = [...byId.values()].sort((a, b) => a.order - b.order);
		return { policy, resolved, occurrences, keep, images };
	}

	function formatImages(images, described) {
		const { policy, resolved } = described;
		if (images.length === 0) {
			return `本会话没有任何图片（上限 ${resolved} 张，${policy.inherit ? '跟随全局默认' : '会话单独设置'}）。`;
		}
		const lines = images.map((image, index) => {
			const name = image.attachment?.name ?? '(未命名)';
			const size = image.attachment?.width && image.attachment?.height ? `${image.attachment.width}x${image.attachment.height}` : '尺寸未知';
			const mark = image.sent ? '发送' : '不发送';
			const label = image.label === undefined ? '' : ` 标识「${image.label}」`;
			return `${index + 1}. id=${image.id} [${mark}] ${name} ${size}${label}`;
		});
		return [
			`会话图片上限：${resolved} 张（${policy.inherit ? `跟随全局默认 ${readGlobalMax()} 张` : '本会话单独设置'}）；当前共 ${images.length} 张，其中发送 ${images.filter((i) => i.sent).length} 张。`,
			...lines,
		].join('\n');
	}

	ctx.tools.register({
		name: 'images_list',
		description:
			'列出当前会话里的全部图片（含每张图是否会被发送）。当用户让你看图片、或会话里图片较多时，先用它挑选要发送的图片，再用 images_select 指定。',
		parameters: {},
		output: textOutput,
		execute(_args, exec) {
			const session = sessionOf(exec.agent);
			if (session === undefined) return 'images_list 只能在 Agent 会话中调用。';
			const described = describe(session);
			return formatImages(described.images, described);
		},
	});

	ctx.tools.register({
		name: 'images_select',
		description:
			"指定本轮请求实际发送哪些图片（其余图片保留在会话中但降级为文字占位符）。传空数组表示回到“只发最新的 N 张”。可以同时给每张图一个简短标识，便于后续引用。",
		parameters: {
			ids: { type: 'array', required: true, items: { type: 'string' }, description: '要发送的图片 id 列表，按优先级排列；传 [] 表示取消指定' },
			labels: { type: 'array', items: { type: 'string' }, description: '与 ids 一一对应的简短标识（可选）' },
		},
		output: textOutput,
		execute(args, exec) {
			const session = sessionOf(exec.agent);
			if (session === undefined) return 'images_select 只能在 Agent 会话中调用。';
			const policy = readPolicy(session);
			const labels = { ...policy.labels };
			const ids = [...new Set((args.ids ?? []).filter((id) => typeof id === 'string'))];
			(args.labels ?? []).forEach((label, index) => {
				const id = ids[index];
				if (typeof id === 'string' && typeof label === 'string' && label.length > 0) labels[id] = label;
			});
			const next = normalizePolicy({ ...policy, pinned: ids, labels }, policy);
			commit(session, next, { force: true });
			const described = describe(session);
			return `已更新发送清单。\n${formatImages(described.images, described)}`;
		},
	});

	ctx.tools.register({
		name: 'images_limit',
		description:
			'设置当前会话每个请求最多发送几张图片。默认跟随全局设置；传 inherit=true 可以清掉会话自己的覆盖值，重新跟随全局。',
		parameters: {
			maxImages: { type: 'integer', description: `1-${MAX_MAX_IMAGES} 之间的整数；与 inherit 二选一` },
			inherit: { type: 'boolean', description: 'true = 清除本会话的覆盖，改为跟随全局默认' },
		},
		output: textOutput,
		execute(args, exec) {
			const session = sessionOf(exec.agent);
			if (session === undefined) return 'images_limit 只能在 Agent 会话中调用。';
			const policy = readPolicy(session);
			const next =
				args.inherit === true
					? normalizePolicy({ ...policy, inherit: true }, policy)
					: normalizePolicy({ ...policy, inherit: false, maxImages: args.maxImages }, policy);
			commit(session, next, { force: true });
			const described = describe(session);
			const what = next.inherit ? `已改为跟随全局默认（${readGlobalMax()} 张）` : `会话图片上限已设为 ${described.resolved} 张`;
			return `${what}。\n${formatImages(described.images, described)}`;
		},
	});

	ctx.tools.register({
		name: 'images_exclude',
		description: '把某些图片从本会话的请求中彻底排除（仍保留在会话与图片管理器里，可用 images_include 恢复）。',
		parameters: {
			ids: { type: 'array', required: true, items: { type: 'string' }, description: '要排除的图片 id 列表' },
		},
		output: textOutput,
		execute(args, exec) {
			const session = sessionOf(exec.agent);
			if (session === undefined) return 'images_exclude 只能在 Agent 会话中调用。';
			const policy = readPolicy(session);
			const ids = (args.ids ?? []).filter((id) => typeof id === 'string');
			const next = normalizePolicy(
				{ ...policy, dropped: [...new Set([...policy.dropped, ...ids])], pinned: policy.pinned.filter((id) => !ids.includes(id)) },
				policy,
			);
			commit(session, next, { force: true });
			const described = describe(session);
			return `已排除 ${ids.length} 张图片。\n${formatImages(described.images, described)}`;
		},
	});

	ctx.tools.register({
		name: 'images_include',
		description: '撤销 images_exclude：让被排除的图片重新参与发送。',
		parameters: {
			ids: { type: 'array', required: true, items: { type: 'string' }, description: '要恢复的图片 id 列表' },
		},
		output: textOutput,
		execute(args, exec) {
			const session = sessionOf(exec.agent);
			if (session === undefined) return 'images_include 只能在 Agent 会话中调用。';
			const policy = readPolicy(session);
			const ids = (args.ids ?? []).filter((id) => typeof id === 'string');
			const next = normalizePolicy({ ...policy, dropped: policy.dropped.filter((id) => !ids.includes(id)) }, policy);
			commit(session, next, { force: true });
			const described = describe(session);
			return `已恢复 ${ids.length} 张图片。\n${formatImages(described.images, described)}`;
		},
	});

	// -- 给浏览器插件用的 HTTP 接口 -------------------------------------------

	const sendJson = (response, status, payload) => {
		response.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' });
		response.end(JSON.stringify(payload));
	};

	const sameOrigin = (request) => {
		const origin = request.headers.origin;
		const host = request.headers.host;
		if (origin === undefined || host === undefined) return false;
		try {
			return new URL(origin).host === host;
		} catch {
			return false;
		}
	};

	const readJsonBody = async (request, maxBytes = 64 * 1024) => {
		const chunks = [];
		let size = 0;
		for await (const chunk of request) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += buffer.length;
			if (size > maxBytes) throw new Error('request body too large');
			chunks.push(buffer);
		}
		return JSON.parse(Buffer.concat(chunks).toString('utf8'));
	};

	const liveSession = (sessionId) => {
		if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
		try {
			return ctx.sessions.get(sessionId) ?? undefined;
		} catch {
			return undefined;
		}
	};

	const statePayload = (session) => {
		const described = describe(session);
		const { policy, images, resolved } = described;
		return {
			apiVersion: API_VERSION,
			sessionId: session.id,
			maxImages: resolved,
			// 会话自己设了值就是 override，否则跟随全局。
			inherit: policy.inherit === true,
			overrideMaxImages: policy.inherit === true ? null : policy.maxImages,
			globalMaxImages: readGlobalMax(),
			defaultMaxImages: DEFAULT_MAX_IMAGES,
			pinned: policy.pinned,
			dropped: policy.dropped,
			images: images.map((image) => ({
				id: image.id,
				label: image.label ?? null,
				name: image.attachment?.name ?? null,
				mediaType: image.attachment?.mediaType ?? null,
				width: image.attachment?.width ?? null,
				height: image.attachment?.height ?? null,
				bytes: image.attachment?.bytes ?? null,
				sent: image.sent,
				excluded: policy.dropped.includes(image.id),
			})),
		};
	};

	const applyPatch = (session, body) => {
		const policy = readPolicy(session);
		const patch = {};
		if (body.inherit === true) {
			patch.inherit = true;
		} else if (body.maxImages !== undefined && body.maxImages !== null) {
			patch.inherit = false;
			patch.maxImages = body.maxImages;
		}
		if (Array.isArray(body.pinned)) patch.pinned = body.pinned;
		if (Array.isArray(body.dropped)) patch.dropped = body.dropped;
		if (isRecord(body.labels)) patch.labels = { ...policy.labels, ...body.labels };
		if (isRecord(body.labelsReplace)) patch.labels = body.labelsReplace;
		const next = normalizePolicy({ ...policy, ...patch }, policy);
		commit(session, next, { force: true });
		return statePayload(session);
	};

	const settingsPayload = () => ({
		apiVersion: API_VERSION,
		maxImages: readGlobalMax(),
		defaultMaxImages: DEFAULT_MAX_IMAGES,
		file: settingsFile,
	});

	ctx.inject?.(['webServer'], (hostCtx) => {
		const webServer = hostCtx.webServer ?? hostCtx.get?.('webServer');
		if (webServer?.register === undefined) return;
		const dispose = webServer.register({
			kind: 'prefix',
			path: API_PREFIX,
			handler: async (request, response) => {
				try {
					const url = new URL(request.url ?? '/', 'http://localhost');
					const route = url.pathname.slice(API_PREFIX.length);

					if (route === '/api/sessions' && request.method === 'GET') {
						const sessions = (ctx.sessions.list?.() ?? []).map((session) => {
							let described = { images: [], policy: defaultPolicy(), resolved: readGlobalMax() };
							try {
								described = describe(session);
							} catch {
								/* 会话不可读时按空处理 */
							}
							return {
								id: session.id,
								title: session.header?.title ?? null,
								images: described.images.length,
								inherit: described.policy.inherit === true,
								maxImages: described.resolved,
							};
						});
						sendJson(response, 200, { sessions, settings: settingsPayload() });
						return;
					}

					if (route === '/api/settings' && request.method === 'GET') {
						sendJson(response, 200, settingsPayload());
						return;
					}

					if (route === '/api/settings' && request.method === 'POST') {
						if (!sameOrigin(request)) {
							sendJson(response, 403, { error: 'CROSS_ORIGIN' });
							return;
						}
						const body = await readJsonBody(request);
						if (body?.maxImages === undefined) {
							sendJson(response, 400, { error: 'MISSING_MAX_IMAGES' });
							return;
						}
						const saved = writeGlobalMax(body.maxImages);
						sendJson(response, 200, { ...settingsPayload(), maxImages: saved });
						return;
					}

					if (route === '/api/state' && request.method === 'GET') {
						const session = liveSession(url.searchParams.get('sessionId') ?? undefined);
						if (session === undefined) {
							sendJson(response, 404, { error: 'SESSION_NOT_LIVE' });
							return;
						}
						sendJson(response, 200, statePayload(session));
						return;
					}

					if (route === '/api/policy' && request.method === 'POST') {
						if (!sameOrigin(request)) {
							sendJson(response, 403, { error: 'CROSS_ORIGIN' });
							return;
						}
						const body = await readJsonBody(request);
						const session = liveSession(body?.sessionId);
						if (session === undefined) {
							sendJson(response, 404, { error: 'SESSION_NOT_LIVE' });
							return;
						}
						sendJson(response, 200, applyPatch(session, body ?? {}));
						return;
					}

					if (route === '/api/image' && request.method === 'GET') {
						const session = liveSession(url.searchParams.get('sessionId') ?? undefined);
						const id = url.searchParams.get('id');
						if (session === undefined || id === null) {
							sendJson(response, 404, { error: 'NOT_FOUND' });
							return;
						}
						const { occurrences } = imagesOf(session, readPolicy(session));
						const found = occurrences.find((item) => item.id === id);
						const ref = found?.attachment;
						if (ref === undefined) {
							sendJson(response, 404, { error: 'IMAGE_NOT_IN_SESSION' });
							return;
						}
						try {
							if (typeof attachments?.readImage !== 'function') {
								sendJson(response, 503, { error: 'ATTACHMENTS_UNAVAILABLE', detail: '附件服务不可用，无法读取图片字节' });
								return;
							}
							const stored = await attachments.readImage(ref);
							const data = stored?.data ?? stored;
							if (data === undefined) throw new Error('no bytes');
							response.writeHead(200, {
								'cache-control': 'private, max-age=60',
								'content-type': ref.mediaType ?? 'application/octet-stream',
							});
							response.end(Buffer.from(data));
						} catch (error) {
							logger?.warn?.(`image-manager: read image ${id} failed: ${error?.message ?? error}`);
							sendJson(response, 500, { error: 'IMAGE_READ_FAILED', detail: String(error?.message ?? error) });
						}
						return;
					}

					sendJson(response, 404, { error: 'NOT_FOUND' });
				} catch (error) {
					sendJson(response, 400, { error: 'BAD_REQUEST', detail: String(error?.message ?? error) });
				}
			},
		});
		hostCtx.effect?.(() => dispose, 'image-manager: http routes');
		logger?.info?.('image-manager: HTTP API mounted at ' + API_PREFIX);
	});
}

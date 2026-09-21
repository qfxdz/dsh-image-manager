/**
 * dsh-image-manager 的核心逻辑离线单测。
 * 用一个假的 cordis ctx + 假 session 驱动：策略读取、决策、投影标记、工具调用。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

// 隔离全局设置的落盘位置，避免读到真实环境的 image-manager.json
process.env.DSH_HOME = '/tmp/im-test-home';
rmSync('/tmp/im-test-home', { recursive: true, force: true });
mkdirSync('/tmp/im-test-home', { recursive: true });

const { apply } = await import('../lib/index.js');

const handlers = new Map();
const tools = new Map();
let projection = null;

const ctx = {
	logger: { info: () => {}, warn: (...a) => console.log('[warn]', ...a) },
	on(event, fn) {
		handlers.set(event, fn);
	},
	tools: { register: (def) => tools.set(def.name, def) },
	sessions: { registerMessageProjection: (def) => { projection = def; } },
};

apply(ctx, undefined);

// ---- 假会话：两条 user 消息，共 5 张图 -------------------------------------
function image(id) {
	return { type: 'image', attachment: { attachmentId: id, mediaType: 'image/png', bytes: 100, width: 4, height: 4 } };
}

const events = [
	{ type: 'system/message', seq: 0, data: { role: 'system', content: [{ type: 'text', text: 'sys' }] } },
	{ type: 'user/message', seq: 1, data: { role: 'user', content: [{ type: 'text', text: 'a' }, image('img-1'), image('img-2'), image('img-3')] } },
	{ type: 'assistant/message', seq: 2, data: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
	{ type: 'user/message', seq: 3, data: { role: 'user', content: [image('img-4'), image('img-5'), { type: 'text', text: 'b' }] } },
];

const session = {
	id: 'test-session',
	seq: 0,
	surface: { nodes: [] },
	appended: [],
	eventAt(seq) {
		return this._events[seq];
	},
	_events: [...events.slice(0, 0)],
	deriveEventMessage(event) {
		return event.data;
	},
	append(type, data) {
		this.appended.push({ type, data });
		this._events.push({ type, seq: this._events.length, data });
		this.seq = this._events.length;
		this.surface.nodes.push(this._events.length - 1);
	},
};

// 初始：0..3 是普通事件
for (const event of events) {
	session._events.push(event);
	session.surface.nodes.push(event.seq);
}
session.seq = session._events.length;

const assert = (label, condition, extra) => {
	console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${condition ? '' : `  <- ${extra ?? ''}`}`);
	if (!condition) process.exitCode = 1;
};

// ---- 1. 默认策略：上限 8，5 张图全部发送（不应写入任何事件） ----------------
const preStep = handlers.get('agent/pre-step');
await preStep({ agent: { session }, signal: { aborted: false } }, async () => {});
assert('默认上限 8 时 5 张图无需写入策略事件', session.appended.length === 0, JSON.stringify(session.appended));

const listText = await tools.get('images_list').execute({}, { agent: { session } });
assert('images_list 列出 5 张图片', (listText.match(/id=img-/g) ?? []).length === 5, listText);
assert('images_list 报告全部发送', listText.includes('发送 5 张'), listText);

// ---- 2. 设上限为 2：应当只保留最新的 2 张（img-4, img-5） -------------------
await tools.get('images_limit').execute({ maxImages: 2 }, { agent: { session } });
await preStep({ agent: { session }, signal: { aborted: false } }, async () => {});
assert('写入了一条策略事件', session.appended.length === 1, JSON.stringify(session.appended));
const policyEvent = session.appended[0].data;
assert('策略事件是 v2 快照且上限为 2', policyEvent.v === 2 && policyEvent.maxImages === 2, JSON.stringify(policyEvent));

const messages = projection.project({ type: 'image/offload', data: policyEvent }, {
	nodes: session.surface.nodes,
	events: session._events,
	baseSeq: 0,
	messages: new Map(),
});
const marks = [];
for (const [seq, message] of messages) {
	for (const block of message.content ?? []) {
		if (block.type === 'image') marks.push(`${block.attachment.attachmentId}:${block.offloaded === true ? 'off' : 'on'}`);
	}
}
assert('只保留最新 2 张，其余标记为 offloaded',
	JSON.stringify(marks) === JSON.stringify(['img-1:off', 'img-2:off', 'img-3:off', 'img-4:on', 'img-5:on']),
	JSON.stringify(marks));

// ---- 3. 让模型挑选 img-1 与 img-5 -----------------------------------------
await tools.get('images_select').execute({ ids: ['img-1', 'img-5'], labels: ['第一张', '最后一张'] }, { agent: { session } });
await preStep({ agent: { session }, signal: { aborted: false } }, async () => {});
const picked = session.appended.at(-1).data;
const messages2 = projection.project({ type: 'image/offload', data: picked }, {
	nodes: session.surface.nodes,
	events: session._events,
	baseSeq: 0,
	messages: new Map(),
});
const marks2 = [];
for (const [, message] of messages2) {
	for (const block of message.content ?? []) {
		if (block.type === 'image') marks2.push(`${block.attachment.attachmentId}:${block.offloaded === true ? 'off' : 'on'}`);
	}
}
assert('挑选后只有 img-1 / img-5 发送（上限 2）',
	JSON.stringify(marks2) === JSON.stringify(['img-1:on', 'img-2:off', 'img-3:off', 'img-4:off', 'img-5:on']),
	JSON.stringify(marks2));
assert('标识被写入策略', picked.labels['img-1'] === '第一张' && picked.labels['img-5'] === '最后一张', JSON.stringify(picked.labels));

// ---- 4. 上限调回 5，且解除挑选 → 恢复所有图片 ------------------------------
await tools.get('images_select').execute({ ids: [] }, { agent: { session } });
await tools.get('images_limit').execute({ maxImages: 5 }, { agent: { session } });
await preStep({ agent: { session }, signal: { aborted: false } }, async () => {});
const restored = session.appended.at(-1).data;
const messages3 = projection.project({ type: 'image/offload', data: restored }, {
	nodes: session.surface.nodes,
	events: session._events,
	baseSeq: 0,
	messages: new Map(),
});
const marks3 = [];
for (const [, message] of messages3) {
	for (const block of message.content ?? []) {
		if (block.type === 'image') marks3.push(`${block.attachment.attachmentId}:${block.offloaded === true ? 'off' : 'on'}`);
	}
}
assert('上限放宽后图片全部恢复（可逆）', marks3.every((entry) => entry.endsWith(':on')), JSON.stringify(marks3));

// ---- 5. 排除 / 恢复 --------------------------------------------------------
await tools.get('images_exclude').execute({ ids: ['img-3'] }, { agent: { session } });
await preStep({ agent: { session }, signal: { aborted: false } }, async () => {});
const excluded = session.appended.at(-1).data;
const messages4 = projection.project({ type: 'image/offload', data: excluded }, {
	nodes: session.surface.nodes,
	events: session._events,
	baseSeq: 0,
	messages: new Map(),
});
const marks4 = [];
for (const [, message] of messages4) {
	for (const block of message.content ?? []) {
		if (block.type === 'image') marks4.push(`${block.attachment.attachmentId}:${block.offloaded === true ? 'off' : 'on'}`);
	}
}
assert('被排除的 img-3 不发送，其余照旧',
	marks4.includes('img-3:off') && marks4.filter((entry) => entry.endsWith(':on')).length === 4,
	JSON.stringify(marks4));

await tools.get('images_include').execute({ ids: ['img-3'] }, { agent: { session } });
await preStep({ agent: { session }, signal: { aborted: false } }, async () => {});
assert('恢复后 img-3 重新发送', (() => {
	const last = session.appended.at(-1).data;
	const messages5 = projection.project({ type: 'image/offload', data: last }, { nodes: session.surface.nodes, events: session._events, baseSeq: 0, messages: new Map() });
	const out = [];
	for (const [, message] of messages5) for (const block of message.content ?? []) if (block.type === 'image') out.push(`${block.attachment.attachmentId}:${block.offloaded === true ? 'off' : 'on'}`);
	return out.every((entry) => entry.endsWith(':on'));
})(), 'restore failed');

// ---- 6. 兼容内置插件的历史 {targets} 事件 ---------------------------------
const legacy = projection.project({ type: 'image/offload', data: { targets: [{ seq: 1, imageIndexes: [0] }] } }, {
	nodes: session.surface.nodes,
	events: session._events,
	baseSeq: 0,
	messages: new Map(),
});
const legacyMarks = [];
for (const [, message] of legacy) for (const block of message.content ?? []) if (block.type === 'image') legacyMarks.push(`${block.attachment.attachmentId}:${block.offloaded === true ? 'off' : 'on'}`);
assert('历史 targets 格式仍可用', legacyMarks.filter((e) => e.endsWith(':off')).length === 1, JSON.stringify(legacyMarks));

// ---- 7. 全局默认 vs 会话覆盖 ----------------------------------------------
const marksOf = (data) => {
	const out = [];
	const produced = projection.project({ type: 'image/offload', data }, { nodes: session.surface.nodes, events: session._events, baseSeq: 0, messages: new Map() });
	for (const [, message] of produced) for (const block of message.content ?? []) if (block.type === 'image') out.push(`${block.attachment.attachmentId}:${block.offloaded === true ? 'off' : 'on'}`);
	return out;
};

// 会话恢复「跟随全局」→ 全局默认 3 → 只发最新 3 张
writeFileSync('/tmp/im-test-home/image-manager.json', JSON.stringify({ maxImages: 3 }));
await tools.get('images_limit').execute({ inherit: true }, { agent: { session } });
await preStep({ agent: { session }, signal: { aborted: false } }, async () => {});
const inheritEvent = session.appended.at(-1).data;
assert('inherit=true 的事件标记为跟随全局', inheritEvent.inherit === true && inheritEvent.maxImages === 3, JSON.stringify(inheritEvent));
const inheritMarks = marksOf(inheritEvent);
assert('跟随全局时按全局默认 3 张保留最新的',
	inheritMarks.filter((e) => e.endsWith(':on')).length === 3 && inheritMarks.slice(0, 2).every((e) => e.endsWith(':off')),
	JSON.stringify(inheritMarks));

// 会话单独设置 5 张 → 覆盖全局的 3 张
await tools.get('images_limit').execute({ maxImages: 5 }, { agent: { session } });
await preStep({ agent: { session }, signal: { aborted: false } }, async () => {});
const overrideEvent = session.appended.at(-1).data;
assert('会话覆盖值写入事件', overrideEvent.inherit === false && overrideEvent.maxImages === 5, JSON.stringify(overrideEvent));
assert('会话覆盖优先于全局默认', marksOf(overrideEvent).filter((e) => e.endsWith(':on')).length === 5, JSON.stringify(marksOf(overrideEvent)));

// 全局改成 1，但会话仍在覆盖 5 → 不受影响；改回跟随 → 立刻按 1 收窄
writeFileSync('/tmp/im-test-home/image-manager.json', JSON.stringify({ maxImages: 1 }));
await preStep({ agent: { session }, signal: { aborted: false } }, async () => {});
assert('会话覆盖期间全局改动不影响该会话',
	marksOf(session.appended.at(-1).data).filter((e) => e.endsWith(':on')).length === 5,
	JSON.stringify(marksOf(session.appended.at(-1).data)));
await tools.get('images_limit').execute({ inherit: true }, { agent: { session } });
await preStep({ agent: { session }, signal: { aborted: false } }, async () => {});
assert('恢复跟随全局后立刻按新全局值 1 收窄',
	marksOf(session.appended.at(-1).data).filter((e) => e.endsWith(':on')).length === 1,
	JSON.stringify(marksOf(session.appended.at(-1).data)));

console.log(process.exitCode === 1 ? '\n== 有用例失败 ==' : '\n== 全部通过 ==');

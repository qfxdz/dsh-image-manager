/**
 * dsh-image-manager 的 HTTP 接口单测（重点是 /api/image —— 图片预览的字节流）。
 *
 * 这里复现过一次真实故障：插件没有在 inject 里声明 attachments，
 * cordis 取属性时直接抛 `cannot get property "attachments" without inject`，
 * 于是 /api/image 返回 500，界面里所有缩略图和大图都变成裂图。
 * 这条用例把「按 ref 读字节并原样返回」钉住。
 */
import { mkdirSync, rmSync } from 'node:fs';

process.env.DSH_HOME = '/tmp/im-http-test-home';
rmSync('/tmp/im-http-test-home', { recursive: true, force: true });
mkdirSync('/tmp/im-http-test-home', { recursive: true });

const { apply } = await import('../lib/index.js');

const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const IMAGE_ID = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function buildSession() {
	const events = [
		{
			type: 'user/message',
			seq: 1,
			data: {
				role: 'user',
				content: [
					{ type: 'text', text: '看图' },
					{
						type: 'image',
						attachment: { attachmentId: IMAGE_ID, mediaType: 'image/jpeg', bytes: JPEG_BYTES.length, width: 1, height: 1, name: 'a.jpg' },
					},
				],
			},
		},
	];
	return {
		id: 'session-http-test',
		seq: 2,
		surface: { nodes: [0, 1] },
		header: { title: 'http test' },
		eventAt: (seq) => events[seq],
		deriveEventMessage: (event) => event.data,
		append: () => {},
	};
}

/** 造一个只满足插件用到的那些接缝的假 ctx。 */
function buildCtx({ withAttachments = true, readImage } = {}) {
	const routes = [];
	const session = buildSession();
	const handlers = new Map();
	const ctx = {
		logger: { info: () => {}, warn: () => {} },
		on: (event, fn) => handlers.set(event, fn),
		tools: { register: () => {} },
		sessions: {
			registerMessageProjection: () => {},
			list: () => [session],
			get: (id) => (id === session.id ? session : undefined),
		},
		get: () => undefined,
		inject: (deps, callback) => {
			if (!deps.includes('webServer')) return;
			callback({
				webServer: {
					register: (route) => {
						routes.push(route);
						return () => {};
					},
				},
				effect: () => {},
			});
		},
	};
	if (withAttachments) {
		ctx.attachments = {
			readImage: readImage ?? (async (ref) => ({ ref, data: JPEG_BYTES })),
		};
	}
	apply(ctx);
	const route = routes.find((item) => item.path === '/dsh-image-manager');
	if (route === undefined) throw new Error('插件没有注册 /dsh-image-manager 路由');
	return { route, session };
}

/** 最小可用的 req/res。 */
function call(route, path, method = 'GET') {
	return new Promise((resolve, reject) => {
		const response = {
			statusCode: 0,
			headers: {},
			body: Buffer.alloc(0),
			writeHead(code, headers) {
				this.statusCode = code;
				Object.assign(this.headers, headers ?? {});
			},
			end(chunk) {
				if (chunk) this.body = Buffer.concat([this.body, Buffer.from(chunk)]);
				resolve(this);
			},
		};
		Promise.resolve(route.handler({ url: path, method, headers: {} }, response)).catch(reject);
	});
}

const assert = (label, condition, extra) => {
	console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${condition ? '' : `  <- ${extra ?? ''}`}`);
	if (!condition) process.exitCode = 1;
};

const PREFIX = '/dsh-image-manager';

// ---- 1. 正常读出图片字节 ---------------------------------------------------
{
	const { route, session } = buildCtx();
	const response = await call(route, `${PREFIX}/api/image?sessionId=${session.id}&id=${encodeURIComponent(IMAGE_ID)}`);
	assert('图片接口返回 200', response.statusCode === 200, String(response.statusCode));
	assert('content-type 取自附件引用', response.headers['content-type'] === 'image/jpeg', response.headers['content-type']);
	assert(
		'返回的就是原始字节（JPEG 魔数 ffd8ff）',
		response.body.length === JPEG_BYTES.length && response.body[0] === 0xff && response.body[1] === 0xd8 && response.body[2] === 0xff,
		`len=${response.body.length} head=${response.body.subarray(0, 3).toString('hex')}`,
	);
}

// ---- 2. 会话里没有这张图 → 404，而不是 500 ---------------------------------
{
	const { route } = buildCtx();
	const response = await call(route, `${PREFIX}/api/image?sessionId=session-http-test&id=sha256:deadbeef`);
	const body = JSON.parse(response.body.toString() || '{}');
	assert('未知图片返回 404', response.statusCode === 404, String(response.statusCode));
	assert('错误码是 IMAGE_NOT_IN_SESSION', body.error === 'IMAGE_NOT_IN_SESSION', response.body.toString());
}

// ---- 3. 附件服务不可用 → 503 + 明确错误码（不是裂图也不是 500）-------------
{
	const { route, session } = buildCtx({ withAttachments: false });
	const response = await call(route, `${PREFIX}/api/image?sessionId=${session.id}&id=${encodeURIComponent(IMAGE_ID)}`);
	const body = JSON.parse(response.body.toString() || '{}');
	assert('附件服务缺失时返回 503', response.statusCode === 503, String(response.statusCode));
	assert('错误码是 ATTACHMENTS_UNAVAILABLE', body.error === 'ATTACHMENTS_UNAVAILABLE', response.body.toString());
}

// ---- 4. readImage 抛错 → 500 且带上原因 ------------------------------------
{
	const { route, session } = buildCtx({
		readImage: async () => {
			throw new Error('ATTACHMENT_CORRUPT');
		},
	});
	const response = await call(route, `${PREFIX}/api/image?sessionId=${session.id}&id=${encodeURIComponent(IMAGE_ID)}`);
	const body = JSON.parse(response.body.toString() || '{}');
	assert('读失败返回 500', response.statusCode === 500, String(response.statusCode));
	assert('错误码是 IMAGE_READ_FAILED 且带原因', body.error === 'IMAGE_READ_FAILED' && String(body.detail).includes('CORRUPT'), response.body.toString());
}

// ---- 5. 其它接口仍在 -------------------------------------------------------
{
	const { route, session } = buildCtx();
	const state = JSON.parse((await call(route, `${PREFIX}/api/state?sessionId=${session.id}`)).body.toString());
	assert('state 接口返回图片清单', state.apiVersion === 2 && state.images.length === 1, JSON.stringify(state));
	const settings = JSON.parse((await call(route, `${PREFIX}/api/settings`)).body.toString());
	assert('settings 接口返回全局默认', settings.apiVersion === 2 && settings.maxImages >= 1, JSON.stringify(settings));
}

console.log(process.exitCode === 1 ? '\n== 有用例失败 ==' : '\n== 全部通过 ==');

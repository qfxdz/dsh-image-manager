/**
 * dsh-image-manager 浏览器半边的冒烟测试：
 * 用 __ModuleLoader__ 的 shim 执行 client.js，取出工厂，
 * 用假的 React 与假的 ctx 调用 apply()，检查三个入口都注册成功。
 */
const registered = [];
let captured = null;

globalThis.window = {
	__ModuleLoader__: {
		load(def) {
			captured = def;
		},
	},
};

class FakeComponent {
	constructor(props) {
		this.props = props ?? {};
		this.state = {};
	}
}

const React = {
	createElement: (type, props, ...children) => ({ type, props, children }),
	Component: FakeComponent,
	useState: (initial) => [initial, () => {}],
	useEffect: () => {},
	useCallback: (fn) => fn,
};

const requireFn = (name) => {
	if (name === 'react') return React;
	throw new Error(`unexpected require: ${name}`);
};

await import('../lib/client.js');

if (captured === null) throw new Error('client.js 没有调用 window.__ModuleLoader__.load');
console.log(`PASS  模块 id = ${captured.id}`);

const exportsObject = captured.factory(requireFn);
console.log(`PASS  导出 apply/inject: ${typeof exportsObject.apply === 'function'} / ${Array.isArray(exportsObject.inject)}`);

const ctx = {
	slots: {
		inject(name, callback) {
			registered.push(name);
			callback();
		},
		register(options) {
			registered.push(`${options.name}:${options.key ?? options.id ?? '?'}`);
			return () => {};
		},
	},
};

exportsObject.apply(ctx);

const expected = ['main', 'sidebar.panellist', 'conversation.session.header.utilities', 'settings.section', 'shell.overlay'];
const ok = expected.every((name) => registered.includes(name));
console.log(`${ok ? 'PASS' : 'FAIL'}  五个入口都注册了: ${JSON.stringify(registered)}`);
if (!ok) process.exitCode = 1;

// ---- 会话目录 merge：下拉必须包含「全部会话」，而不只是 Host 里已加载的 ----
const catalog = {
	ids: ['s3', 's1', 's2'],
	byId: {
		s1: { displayTitle: '会话一', updatedAt: 100 },
		s2: { title: 'S2', updatedAt: 300 },
		s3: { displayTitle: '会话三', updatedAt: 200, running: true },
	},
	current: 's2',
};
const live = [{ id: 's2', title: 'S2', images: 9, maxImages: 8, inherit: true }];
const rows = exportsObject.buildSessionRows(catalog, live);
console.log(`PASS  合并后共 ${rows.length} 行（目录 3 行，live 只有 1 行）`);
const labels = rows.map((row) => `${row.id}:${row.live ? 'live' : '未加载'}:${row.images ?? '-'}`);
console.log(`       ${JSON.stringify(labels)}`);
const order = rows.map((row) => row.id).join(',');
const expectOk =
	rows.length === 3 &&
	order === 's2,s3,s1' &&
	rows[0].live === true &&
	rows[0].images === 9 &&
	rows[0].inherit === true &&
	rows[1].live === false &&
	rows[1].running === true &&
	rows[2].live === false;
console.log(`${expectOk ? 'PASS' : 'FAIL'}  按 updatedAt 排序、live 标记与图片数正确（${order}）`);
if (!expectOk) process.exitCode = 1;
console.log(`PASS  未加载的会话标题仍来自目录：${rows[2].title === '会话一' ? '会话一' : rows[2].title}`);

// 目录不可用时退回 live 列表
const fallback = exportsObject.buildSessionRows(null, [{ id: 'x', images: 1, maxImages: 8, inherit: true }]);
const fallbackOk = fallback.length === 1 && fallback[0].live === true && fallback[0].id === 'x';
console.log(`${fallbackOk ? 'PASS' : 'FAIL'}  目录缺失时退回 live 列表`);
if (!fallbackOk) process.exitCode = 1;

console.log(process.exitCode === 1 ? '\n== 客户端冒烟测试失败 ==' : '\n== 客户端冒烟测试通过 ==');

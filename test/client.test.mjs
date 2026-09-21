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

// ---- 会话目录 merge：只列真正的会话 ----------------------------------------
const catalog = {
	ids: ['s1', 's2', 's3', 's4', 's5', 's6', 's7'],
	current: 's3',
	byId: {
		s1: { displayTitle: '修复登录', updatedAt: 500 },
		s2: { displayTitle: '子代理A', origin: 'subagent', parentId: 's1', updatedAt: 900 },
		s3: { displayTitle: 'ceshi', blank: true, updatedAt: 800 },
		s4: { displayTitle: 'ceshi', blank: true, updatedAt: 700 },
		s5: { displayTitle: '已归档的会话', updatedAt: 600 },
		s6: { displayTitle: 'ceshi', updatedAt: 400 },
		s7: { displayTitle: 'ceshi', updatedAt: 300 },
	},
};
const live = [{ id: 's1', title: '修复登录', images: 9, maxImages: 8, inherit: true }];
const archived = ['s5'];
const rows = exportsObject.buildSessionRows(catalog, live, archived);
const ids = rows.map((row) => row.id).join(',');

const filterOk = ids === 's3,s1,s6,s7';
console.log(`${filterOk ? 'PASS' : 'FAIL'}  过滤子代理/归档/非当前空会话，按 updatedAt 倒序：${ids}`);
if (!filterOk) process.exitCode = 1;

console.log(`PASS  当前空会话显示为占位标题：${rows[0].title}`);
const liveOk = rows[1].live === true && rows[1].images === 9 && rows[1].inherit === true;
console.log(`${liveOk ? 'PASS' : 'FAIL'}  live 会话带图片数与归属：${JSON.stringify({ id: rows[1].id, live: rows[1].live, images: rows[1].images })}`);
if (!liveOk) process.exitCode = 1;

const dedup = rows.filter((row) => row.title.startsWith('ceshi'));
const dedupOk = dedup.length === 2 && dedup.every((row) => /ceshi · \S+$/.test(row.title)) && dedup[0].title !== dedup[1].title;
console.log(`${dedupOk ? 'PASS' : 'FAIL'}  同名会话补短 id 去重：${JSON.stringify(dedup.map((row) => row.title))}`);
if (!dedupOk) process.exitCode = 1;

// 目录不可用时退回 live 列表（仍按归档集合过滤）
const fallback = exportsObject.buildSessionRows(null, [{ id: 'x', images: 1, maxImages: 8, inherit: true }, { id: 'y' }], ['y']);
const fallbackOk = fallback.length === 1 && fallback[0].id === 'x' && fallback[0].live === true;
console.log(`${fallbackOk ? 'PASS' : 'FAIL'}  目录缺失时退回 live 列表并过滤归档`);
if (!fallbackOk) process.exitCode = 1;

console.log(process.exitCode === 1 ? '\n== 客户端冒烟测试失败 ==' : '\n== 客户端冒烟测试通过 ==');

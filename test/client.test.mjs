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

console.log(process.exitCode === 1 ? '\n== 客户端冒烟测试失败 ==' : '\n== 客户端冒烟测试通过 ==');

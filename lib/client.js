/**
 * dsh-image-manager —— 浏览器（Web UI）半边。
 *
 * 手写的 __ModuleLoader__ 工厂包（无需构建工具）。四个入口：
 *   1. 会话按钮   conversation.session.header.utilities → 「图片 N/M」，点开当前会话的管理弹窗；
 *   2. 设置页面   settings.section                      → 全局默认上限 + 「打开图片管理器」按钮；
 *   3. 管理弹窗   shell.overlay                         → 会话模式 / 全局模式共用一个弹窗；
 *   4. 侧边栏入口 sidebar.panellist + main              → 全局管理页（默认值 + 会话清单）。
 *
 * 优先级：会话自己设了上限 → 用会话的；没设（跟随全局）→ 用全局默认。
 * 所有数据都走 Host 的 /dsh-image-manager/api/* 接口。
 */
window.__ModuleLoader__.load({
	id: 'dsh-image-manager',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require('react');
		const h = React.createElement;

		const PANEL_ID = 'image-manager';
		const API = '/dsh-image-manager/api';
		const inject = ['slots'];

		// ---------------------------------------------------------------
		// 会话 id 解析 / HTTP
		// ---------------------------------------------------------------

		function sessionIdFromLocation() {
			try {
				const { search, hash, pathname } = window.location;
				const params = new URLSearchParams(search);
				for (const key of ['session', 'sessionId', 'session_id', 'id']) {
					const value = params.get(key);
					if (value !== null && value.length > 0) return value;
				}
				const hashParams = new URLSearchParams(hash.replace(/^#/, ''));
				for (const key of ['session', 'sessionId', 'id']) {
					const value = hashParams.get(key);
					if (value !== null && value.length > 0) return value;
				}
				const matched = /(?:sessions?|chat)\/([A-Za-z0-9._-]{6,})/.exec(pathname);
				if (matched !== null) return matched[1];
			} catch {
				/* ignore */
			}
			return null;
		}

		async function readJson(response) {
			const text = await response.text();
			if (text.length === 0) return {};
			try {
				return JSON.parse(text);
			} catch {
				return { error: 'BAD_JSON', detail: text.slice(0, 200) };
			}
		}

		/**
		 * 把 Host 返回的错误翻译成人能看懂的话。
		 * 浏览器半边每次刷新都会从磁盘读最新代码，而 Host 只在进程启动时加载一次，
		 * 所以「界面是新的、Host 还是旧的」是正常现象：这时 Host 没有这些接口，会回 NOT_FOUND。
		 */
		function hostError(body, status) {
			if (body?.error === 'NOT_FOUND') {
				return '宿主插件未加载或版本较旧（Host 半边只在 dsh 启动时加载，浏览器半边是刷新即更新）。请重启 dsh（用你机器上 dsh 安装目录里的 stop.sh / start.sh）。';
			}
			return body?.error ?? `HTTP ${status}`;
		}

		async function fetchState(sessionId) {
			const response = await fetch(`${API}/state?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
			const body = await readJson(response);
			if (!response.ok) throw new Error(hostError(body, response.status));
			return body;
		}

		async function fetchSessions() {
			const response = await fetch(`${API}/sessions`, { cache: 'no-store' });
			const body = await readJson(response);
			if (!response.ok) throw new Error(hostError(body, response.status));
			return body.sessions ?? [];
		}

		async function fetchSettings() {
			const response = await fetch(`${API}/settings`, { cache: 'no-store' });
			const body = await readJson(response);
			if (!response.ok) throw new Error(hostError(body, response.status));
			return body;
		}

		async function postJson(path, payload) {
			const response = await fetch(`${API}${path}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload),
			});
			const body = await readJson(response);
			if (!response.ok) throw new Error(hostError(body, response.status));
			return body;
		}

		const postPolicy = (patch) => postJson('/policy', patch);
		const postSettings = (maxImages) => postJson('/settings', { maxImages });

		function imageUrl(sessionId, id) {
			return `${API}/image?sessionId=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(id)}`;
		}

		// ---------------------------------------------------------------
		// 共享 UI 状态：当前打开的管理弹窗（会话 / 全局共用）
		// ---------------------------------------------------------------

		/** 客户端会话目录服务（ctx.sessions）：左侧会话栏用的就是它的 list。 */
		let sessionsService;

		const listeners = new Set();
		let modalState = null; // null | { mode: 'session'|'global', sessionId?: string }

		const modalStore = {
			subscribe(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			getSnapshot() {
				return modalState;
			},
			open(next) {
				modalState = next;
				for (const listener of listeners) listener();
			},
			close() {
				modalState = null;
				for (const listener of listeners) listener();
			},
		};

		function useModal() {
			if (typeof React.useSyncExternalStore === 'function') {
				return React.useSyncExternalStore(modalStore.subscribe, modalStore.getSnapshot);
			}
			const [value, setValue] = React.useState(modalStore.getSnapshot());
			React.useEffect(
				() => modalStore.subscribe(() => setValue(modalStore.getSnapshot())),
				[],
			);
			return value;
		}

		// ---------------------------------------------------------------
		// 样式
		// ---------------------------------------------------------------

		const styles = {
			root: { display: 'flex', flexDirection: 'column', minHeight: '100%', padding: '12px 16px', gap: 12, boxSizing: 'border-box' },
			toolbar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
			title: { fontSize: 15, fontWeight: 600, marginRight: 4 },
			select: { padding: '4px 6px', borderRadius: 6, border: '1px solid var(--dsh-border, #d0d5dd)', background: 'transparent', color: 'inherit', maxWidth: 300 },
			input: { width: 74, padding: '4px 6px', borderRadius: 6, border: '1px solid var(--dsh-border, #d0d5dd)', background: 'transparent', color: 'inherit' },
			button: { padding: '4px 10px', borderRadius: 6, border: '1px solid var(--dsh-border, #d0d5dd)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12 },
			buttonPrimary: { padding: '4px 10px', borderRadius: 6, border: '1px solid transparent', background: 'var(--dsh-accent, #4d6bfe)', color: '#fff', cursor: 'pointer', fontSize: 12 },
			headerButton: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 999, border: '1px solid var(--dsh-border, #d0d5dd)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12 },
			dot: (inherit) => ({ width: 6, height: 6, borderRadius: 999, background: inherit ? '#98a2b3' : '#4d6bfe' }),
			muted: { opacity: 0.65, fontSize: 12, lineHeight: 1.7 },
			error: { color: '#d92d20', fontSize: 12, whiteSpace: 'pre-wrap' },
			hint: { background: 'rgba(127,127,127,0.12)', borderRadius: 8, padding: '8px 10px', fontSize: 12, lineHeight: 1.7 },
			grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 },
			card: { border: '1px solid var(--dsh-border, #d0d5dd)', borderRadius: 10, padding: 8, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
			thumbWrap: { position: 'relative', width: '100%', height: 128, background: 'rgba(127,127,127,0.12)', borderRadius: 8, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-in' },
			thumb: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' },
			badge: (sent) => ({ position: 'absolute', top: 6, left: 6, padding: '1px 6px', borderRadius: 999, fontSize: 11, color: '#fff', background: sent ? '#12b76a' : '#98a2b3' }),
			cardName: { fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
			cardMeta: { fontSize: 11, opacity: 0.65, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
			row: { display: 'flex', gap: 6, flexWrap: 'wrap' },
			modalMask: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9000, padding: 24 },
			modalCard: { width: 'min(1000px, 94vw)', height: 'min(780px, 88vh)', background: 'var(--dsh-surface, #fff)', color: 'inherit', borderRadius: 14, border: '1px solid var(--dsh-border, #d0d5dd)', boxShadow: '0 18px 48px rgba(0,0,0,0.28)', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
			modalHead: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--dsh-border, #d0d5dd)' },
			modalBody: { flex: 1, minHeight: 0, overflow: 'auto' },
			overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, cursor: 'zoom-out' },
			overlayImage: { maxWidth: '92vw', maxHeight: '92vh', objectFit: 'contain', borderRadius: 6, background: '#fff' },
		};

		// ---------------------------------------------------------------
		// 图片网格
		// ---------------------------------------------------------------

		/**
		 * 缩略图：加载失败时给出可读提示与「重试」，而不是浏览器的裂图图标。
		 * @param props.src - 图片地址
		 * @param props.alt - 无障碍文本
		 * @param props.onOpen - 点击打开大图（可选）
		 */
		function Thumb({ src, alt, onOpen, style }) {
			const [state, setState] = React.useState('loading');
			const [nonce, setNonce] = React.useState(0);
			if (state === 'error') {
				return h(
					'div',
					{ style: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%', height: '100%', fontSize: 12, opacity: 0.75 } },
					h('span', null, '图片加载失败'),
					h(
						'button',
						{
							style: styles.button,
							onClick: (event) => {
								event.stopPropagation();
								setState('loading');
								setNonce((value) => value + 1);
							},
						},
						'重试',
					),
				);
			}
			return h('img', {
				style: style ?? styles.thumb,
				src: nonce === 0 ? src : `${src}&retry=${nonce}`,
				alt,
				loading: 'lazy',
				onClick: onOpen,
				onError: () => setState('error'),
				onLoad: () => setState('ok'),
			});
		}

		function ImageCard({ sessionId, image, onPreview, onToggleSend, onToggleExclude, busy }) {
			return h(
				'div',
				{ style: styles.card },
				h(
					'div',
					{ style: styles.thumbWrap, onClick: () => onPreview(image) },
					h(Thumb, { src: imageUrl(sessionId, image.id), alt: image.label ?? image.name ?? image.id }),
					h('span', { style: styles.badge(image.sent) }, image.sent ? '发送' : '不发送'),
				),
				h('div', { style: styles.cardName, title: image.name ?? image.id }, image.label === null ? image.name ?? image.id : `${image.label} · ${image.name ?? image.id}`),
				h(
					'div',
					{ style: styles.cardMeta },
					[
						image.width !== null && image.height !== null ? `${image.width}×${image.height}` : null,
						image.mediaType ?? null,
						image.bytes !== null ? `${Math.round(image.bytes / 1024)} KB` : null,
					]
						.filter(Boolean)
						.join(' · '),
				),
				h(
					'div',
					{ style: styles.row },
					h('button', { style: styles.button, disabled: busy, onClick: () => onToggleSend(image) }, image.sent ? '不发送' : '发送'),
					h('button', { style: styles.button, disabled: busy, onClick: () => onToggleExclude(image) }, image.excluded ? '恢复' : '排除'),
					h('button', { style: styles.button, onClick: () => onPreview(image) }, '预览'),
				),
			);
		}

		// ---------------------------------------------------------------
		// 管理主体：全局默认 + 会话覆盖
		// ---------------------------------------------------------------

		/**
		 * 把「完整会话目录」与「Host live 信息」合成下拉数据。
		 * 目录缺失时退回 live 列表（服务不可用时的降级）。
		 * @param catalog - SessionListState（ctx.sessions.list 的快照）
		 * @param live - /api/sessions 返回的 live 会话（含图片数、上限、是否跟随全局）
		 */
		function buildSessionRows(catalog, live) {
			const liveById = new Map((live ?? []).map((item) => [item.id, item]));
			if (catalog?.ids === undefined) {
				return (live ?? []).map((item) => ({ ...item, title: item.title ?? item.id, live: true, updatedAt: 0 }));
			}
			return catalog.ids
				.map((id) => {
					const summary = catalog.byId?.[id] ?? {};
					const info = liveById.get(id);
					return {
						id,
						title: summary.displayTitle ?? summary.title ?? id,
						live: info !== undefined,
						running: summary.running === true,
						updatedAt: summary.updatedAt ?? 0,
						images: info?.images ?? null,
						maxImages: info?.maxImages ?? null,
						inherit: info?.inherit ?? null,
					};
				})
				.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
		}

		/**
		 * 订阅客户端会话目录（SessionListState）。拿不到服务时返回 null，
		 * 调用方退回 Host 的 live 列表。
		 */
		function useCatalog() {
			const source = sessionsService?.list;
			const subscribe = React.useCallback(
				(notify) => (typeof source?.subscribe === 'function' ? source.subscribe(notify) : () => {}),
				[source],
			);
			const getSnapshot = React.useCallback(() => source?.getSnapshot?.() ?? null, [source]);
			if (typeof React.useSyncExternalStore === 'function') return React.useSyncExternalStore(subscribe, getSnapshot);
			const [value, setValue] = React.useState(getSnapshot);
			React.useEffect(() => subscribe(() => setValue(getSnapshot())), [subscribe, getSnapshot]);
			return value;
		}

		function ImageManager({ mode = 'session', sessionId: initialSessionId, sessions, reloadSessions }) {
			const [sessionId, setSessionId] = React.useState(initialSessionId ?? sessionIdFromLocation());
			const [state, setState] = React.useState(null);
			const [settings, setSettings] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [preview, setPreview] = React.useState(null);
			const [draftMax, setDraftMax] = React.useState('');
			const [globalDraft, setGlobalDraft] = React.useState('');
			const [scope, setScope] = React.useState('inherit');

			// 会话目录（全部会话）与 Host live 信息（图片数/上限）合并成下拉数据。
			const catalog = useCatalog();
			const rows = React.useMemo(() => buildSessionRows(catalog, sessions ?? []), [catalog, sessions]);
			const selectedRow = rows.find((row) => row.id === sessionId);
			const sessionLoaded = catalog?.ids === undefined ? true : selectedRow?.live === true;

			React.useEffect(() => {
				if (initialSessionId !== undefined && initialSessionId !== null) setSessionId(initialSessionId);
			}, [initialSessionId]);

			const reload = React.useCallback(async () => {
				try {
					const nextSettings = await fetchSettings();
					setSettings(nextSettings);
					setGlobalDraft(String(nextSettings.maxImages));
				} catch {
					/* 全局设置读不到不阻塞会话管理 */
				}
				if (sessionId === null || sessionId === undefined || sessionId.length === 0) {
					setState(null);
					return;
				}
				try {
					const next = await fetchState(sessionId);
					setState(next);
					setScope(next.inherit ? 'inherit' : 'override');
					setDraftMax(String(next.overrideMaxImages ?? next.maxImages));
					setError(null);
				} catch (failure) {
					setError(`读取失败：${failure.message}（会话可能尚未在本进程加载）`);
					setState(null);
				}
			}, [sessionId]);

			React.useEffect(() => {
				reload();
				const timer = window.setInterval(reload, 4000);
				// 会话目录由客户端的 session controller 维护，进来时刷一次。
				try {
					sessionsService?.refresh?.();
				} catch {
					/* 刷新失败不影响已有数据 */
				}
				return () => window.clearInterval(timer);
			}, [reload]);

			// 没显式指定会话时，跟随目录里的「当前会话」。
			React.useEffect(() => {
				if (sessionId !== null && sessionId !== undefined && sessionId.length > 0) return;
				const current = catalog?.current;
				if (typeof current === 'string' && current.length > 0) setSessionId(current);
			}, [catalog, sessionId]);

			const apply = React.useCallback(
				async (patch) => {
					if (sessionId === null || sessionId === undefined) return;
					setBusy(true);
					try {
						const next = await postPolicy({ sessionId, ...patch });
						setState(next);
						setScope(next.inherit ? 'inherit' : 'override');
						setDraftMax(String(next.overrideMaxImages ?? next.maxImages));
						setError(null);
						if (reloadSessions !== undefined) await reloadSessions();
					} catch (failure) {
						setError(`写入失败：${failure.message}`);
					} finally {
						setBusy(false);
					}
				},
				[sessionId, reloadSessions],
			);

			const saveGlobal = React.useCallback(async () => {
				setBusy(true);
				try {
					const next = await postSettings(Number(globalDraft));
					setSettings(next);
					setGlobalDraft(String(next.maxImages));
					setError(null);
					if (reloadSessions !== undefined) await reloadSessions();
					await reload();
				} catch (failure) {
					setError(`写入全局默认失败：${failure.message}`);
				} finally {
					setBusy(false);
				}
			}, [globalDraft, reload, reloadSessions]);

			const onToggleSend = (image) => {
				const sent = new Set((state?.images ?? []).filter((item) => item.sent).map((item) => item.id));
				if (sent.has(image.id)) sent.delete(image.id);
				else sent.add(image.id);
				apply({ pinned: [...sent] });
			};

			const onToggleExclude = (image) => {
				const excluded = new Set((state?.images ?? []).filter((item) => item.excluded).map((item) => item.id));
				if (excluded.has(image.id)) excluded.delete(image.id);
				else excluded.add(image.id);
				apply({ dropped: [...excluded] });
			};

			const images = state?.images ?? [];
			const globalMax = settings?.maxImages ?? null;

			return h(
				'div',
				{ style: styles.root },
				h(
					'div',
					{ style: styles.toolbar },
					h('span', { style: styles.title }, '全局默认'),
					h('span', { style: styles.muted }, '每个请求最多发送'),
					h('input', { style: styles.input, type: 'number', min: 1, max: 256, value: globalDraft, onChange: (event) => setGlobalDraft(event.target.value) }),
					h('button', { style: styles.buttonPrimary, disabled: busy || globalDraft.length === 0, onClick: saveGlobal }, '保存全局默认'),
					h('span', { style: styles.muted }, '会话没单独设置时用这个值'),
				),
				h('div', { style: styles.hint }, '优先级：会话单独设置 > 全局默认。会话里没设置（跟随全局）时，改全局会立刻影响它；会话里设过值就固定用会话的值，直到在会话里点「改回跟随全局」。'),

				h(
					'div',
					{ style: styles.toolbar },
					h(
						'select',
						{ style: styles.select, value: sessionId ?? '', onChange: (event) => setSessionId(event.target.value) },
						[
							h('option', { key: '__none', value: '' }, '（选择会话）'),
							...rows.map((row) =>
								h(
									'option',
									{ key: row.id, value: row.id },
									row.live
										? `${row.title}（${row.images} 图 · ${row.inherit ? `跟随全局 ${row.maxImages}` : `自定义 ${row.maxImages}`}）`
										: `${row.title}（未加载）`,
								),
							),
						],
					),
					h('button', { style: styles.button, onClick: reload }, '刷新'),
				),

				h(
					'div',
					{ style: styles.toolbar },
					h('span', { style: styles.muted }, `本会话上限（${mode === 'session' ? '当前会话' : '选中会话'}）`),
					h(
						'select',
						{ style: styles.select, value: scope, onChange: (event) => setScope(event.target.value), disabled: state === null },
						[
							h('option', { key: 'inherit', value: 'inherit' }, `跟随全局${globalMax === null ? '' : `（${globalMax}）`}`),
							h('option', { key: 'override', value: 'override' }, '自定义'),
						],
					),
					scope === 'override' &&
						h('input', { style: styles.input, type: 'number', min: 1, max: 256, value: draftMax, onChange: (event) => setDraftMax(event.target.value) }),
					h(
						'button',
						{
							style: styles.buttonPrimary,
							disabled: busy || state === null,
							onClick: () => (scope === 'inherit' ? apply({ inherit: true }) : apply({ maxImages: Number(draftMax) })),
						},
						'保存本会话设置',
					),
					h('button', { style: styles.button, disabled: busy || state === null, onClick: () => apply({ inherit: true }) }, '改回跟随全局'),
					h('button', { style: styles.button, disabled: busy || state === null, onClick: () => apply({ pinned: [] }) }, '回到「最新 N 张」'),
				),

				error !== null ? h('div', { style: styles.error }, error) : null,
				!sessionLoaded
					? h(
							'div',
							{ style: styles.hint },
							'这个会话还没有在 Host 进程里加载，所以暂时读不到它的图片。点下面的「打开该会话」把它加载进来（会切换左侧当前会话），之后再回来管理。',
						)
					: null,
				!sessionLoaded
					? h(
							'div',
							{ style: styles.toolbar },
							h(
								'button',
								{
									style: styles.buttonPrimary,
									onClick: () => {
										try {
											sessionsService?.open?.(sessionId);
										} catch (failure) {
											setError(`打开会话失败：${failure?.message ?? failure}`);
										}
									},
								},
								'打开该会话',
							),
						)
					: null,
				state === null || !sessionLoaded
					? h('div', { style: styles.muted }, sessionLoaded ? '选择一个会话后即可管理它的图片。' : '')
					: h(
							'div',
							{ style: styles.muted },
							`共 ${images.length} 张，发送 ${images.filter((item) => item.sent).length} 张，生效上限 ${state.maxImages} 张（${state.inherit ? `跟随全局 ${state.globalMaxImages}` : '会话自定义'}）。绿色徽标 = 会随请求发送；“排除”的图片不会再进入任何请求，可随时恢复。`,
						),

				images.length > 0
					? h(
							'div',
							{ style: styles.grid },
							images.map((image) => h(ImageCard, { key: image.id, sessionId, image, busy, onPreview: setPreview, onToggleSend, onToggleExclude })),
						)
					: null,

				preview === null
					? null
					: h(
							'div',
							{ style: styles.overlay, onClick: () => setPreview(null) },
							h(Thumb, { style: styles.overlayImage, src: imageUrl(sessionId, preview.id), alt: preview.label ?? preview.name ?? preview.id }),
						),
			);
		}

		// ---------------------------------------------------------------
		// 入口 1：会话头部按钮
		// ---------------------------------------------------------------

		function SessionImagesButton({ sessionId }) {
			const [info, setInfo] = React.useState(null);

			React.useEffect(() => {
				let alive = true;
				if (sessionId === undefined) return () => {};
				const load = () => {
					fetchState(sessionId)
						.then((next) => {
							if (alive) setInfo(next);
						})
						.catch(() => {
							if (alive) setInfo(null);
						});
				};
				load();
				const timer = window.setInterval(load, 5000);
				return () => {
					alive = false;
					window.clearInterval(timer);
				};
			}, [sessionId]);

			if (sessionId === undefined) return null;
			const count = info?.images?.length ?? 0;
			const max = info?.maxImages ?? '…';
			const inherit = info?.inherit !== false;

			return h(
				'button',
				{
					type: 'button',
					style: styles.headerButton,
					title: `管理本会话的图片（上限${inherit ? '跟随全局' : '由本会话单独设置'}）`,
					onClick: () => modalStore.open({ mode: 'session', sessionId }),
				},
				h('span', { style: styles.dot(inherit) }),
				`图片 ${count}/${max}`,
			);
		}

		// ---------------------------------------------------------------
		// 入口 2：设置里的管理区
		// ---------------------------------------------------------------

		function SettingsSection() {
			const [settings, setSettings] = React.useState(null);
			const [sessions, setSessions] = React.useState([]);
			const [draft, setDraft] = React.useState('');
			const [error, setError] = React.useState(null);
			const [busy, setBusy] = React.useState(false);

			const reload = React.useCallback(async () => {
				try {
					const body = await readJson(await fetch(`${API}/sessions`, { cache: 'no-store' }));
					if (body.settings !== undefined) {
						setSettings(body.settings);
						setDraft(String(body.settings.maxImages));
					}
					setSessions(body.sessions ?? []);
					setError(null);
				} catch (failure) {
					setError(`读取失败：${failure.message}`);
				}
			}, []);

			React.useEffect(() => {
				reload();
			}, [reload]);

			const save = async () => {
				setBusy(true);
				try {
					await postSettings(Number(draft));
					await reload();
				} catch (failure) {
					setError(`保存失败：${failure.message}`);
				} finally {
					setBusy(false);
				}
			};

			const catalog = useCatalog();
			const total = catalog?.ids?.length;

			return h(
				'div',
				{ style: { display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0' } },
				h('div', { style: styles.title }, '图片管理'),
				h('div', { style: styles.hint }, '控制图片怎么进入模型请求：每个会话最多发送几张、发送哪几张。优先级：会话单独设置 > 全局默认；会话没设置时跟随全局默认。'),
				h(
					'div',
					{ style: styles.toolbar },
					h('span', { style: styles.muted }, '全局默认：每个请求最多发送'),
					h('input', { style: styles.input, type: 'number', min: 1, max: 256, value: draft, onChange: (event) => setDraft(event.target.value) }),
					h('button', { style: styles.buttonPrimary, disabled: busy || draft.length === 0, onClick: save }, '保存'),
					h('button', { style: styles.buttonPrimary, onClick: () => modalStore.open({ mode: 'global' }) }, '打开图片管理器'),
					h('button', { style: styles.button, onClick: reload }, '刷新'),
				),
				error !== null ? h('div', { style: styles.error }, error) : null,
				h('div', { style: styles.muted }, `当前全局默认：${settings?.maxImages ?? '…'} 张；配置文件：${settings?.file ?? '…'}`),
				h(
					'div',
					{ style: styles.muted },
					`会话：共 ${total ?? '?'} 个，本进程已加载 ${sessions.length} 个${sessions.length === 0 ? '（未加载的会话在管理面板里点「打开该会话」即可）' : `：${sessions.map((session) => `${session.title ?? session.id}（${session.images} 图${session.inherit ? '' : '·自定义'}）`).join('、')}`}`,
				),
			);
		}

		// ---------------------------------------------------------------
		// 入口 3：管理弹窗（会话 / 全局共用）
		// ---------------------------------------------------------------

		function ManagerModal() {
			const modal = useModal();
			const [sessions, setSessions] = React.useState([]);

			const reloadSessions = React.useCallback(async () => {
				try {
					setSessions(await fetchSessions());
				} catch {
					/* 列表失败不影响管理本身 */
				}
			}, []);

			const open = modal !== null;
			React.useEffect(() => {
				if (open) reloadSessions();
			}, [open, reloadSessions]);

			React.useEffect(() => {
				if (!open) return () => {};
				const onKey = (event) => {
					if (event.key === 'Escape') modalStore.close();
				};
				window.addEventListener('keydown', onKey);
				return () => window.removeEventListener('keydown', onKey);
			}, [open]);

			if (!open) return null;

			return h(
				'div',
				{
					style: styles.modalMask,
					onMouseDown: (event) => {
						if (event.target === event.currentTarget) modalStore.close();
					},
				},
				h(
					'div',
					{ style: styles.modalCard, role: 'dialog', 'aria-modal': 'true', 'aria-label': '图片管理' },
					h(
						'div',
						{ style: styles.modalHead },
						h('span', { style: styles.title }, modal.mode === 'global' ? '图片管理器（全局）' : '图片管理器（本会话）'),
						h('span', { style: { flex: 1 } }),
						h('button', { style: styles.button, onClick: () => modalStore.close() }, '关闭'),
					),
					h(
						'div',
						{ style: styles.modalBody },
						h(Guarded, {
							mode: modal.mode,
							sessionId: modal.mode === 'session' ? modal.sessionId : sessionIdFromLocation(),
							sessions,
							reloadSessions,
						}),
					),
				),
			);
		}

		// ---------------------------------------------------------------
		// 入口 4：侧边栏 / 主面板（全局管理页）
		// ---------------------------------------------------------------

		function GlobalPanelInner() {
			const [sessions, setSessions] = React.useState([]);
			const reload = React.useCallback(async () => {
				try {
					setSessions(await fetchSessions());
				} catch {
					/* ignore */
				}
			}, []);
			React.useEffect(() => {
				reload();
				const timer = window.setInterval(reload, 6000);
				return () => window.clearInterval(timer);
			}, [reload]);
			return h(Guarded, { mode: 'global', sessions, reloadSessions: reload });
		}

		/** 侧边栏图标。 */
		function ImagesIcon() {
			return h(
				'svg',
				{ width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true },
				h('rect', { x: 2, y: 3, width: 12, height: 10, rx: 2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
				h('circle', { cx: 6, cy: 6.5, r: 1.2, fill: 'currentColor' }),
				h('path', { d: 'M3.2 11.4 6.4 8.6l2.2 2 1.8-1.6 2.4 2.4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
			);
		}

		// ---------------------------------------------------------------
		// 错误边界
		// ---------------------------------------------------------------

		class Boundary extends React.Component {
			constructor(props) {
				super(props);
				this.state = { error: null };
			}
			static getDerivedStateFromError(error) {
				return { error };
			}
			render() {
				if (this.state.error !== null) {
					return h('div', { style: styles.error }, `图片管理器出错：${String(this.state.error?.message ?? this.state.error)}`);
				}
				return this.props.children;
			}
		}

		function Guarded(props) {
			return h(Boundary, null, h(ImageManager, props));
		}

		/**
		 * 注册四个入口；每处单独兜底，某一处失败不影响其它入口。
		 * @param ctx - 浏览器插件上下文。
		 */
		function apply(ctx) {
			// cordis 对未注入的服务取属性会抛错，所以显式拿一次 + 用 ctx.inject 兜住晚到/重载。
			try {
				sessionsService = ctx.sessions;
			} catch {
				sessionsService = undefined;
			}
			try {
				ctx.inject?.(['sessions'], (scoped) => {
					sessionsService = scoped.sessions ?? sessionsService;
				});
			} catch {
				/* 没有该服务时面板仍可用，只是会话列表退回 Host 的 live 列表 */
			}

			const guard = (label, run) => {
				try {
					run();
				} catch (error) {
					console.error(`[dsh-image-manager] ${label} registration failed`, error);
				}
			};

			guard('main panel', () => ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, GlobalPanelInner)));
			guard('sidebar entry', () =>
				ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => '图片' }, ImagesIcon)),
			);
			guard('session button', () =>
				ctx.slots.inject('conversation.session.header.utilities', () =>
					ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'image-manager', order: 20 }, SessionImagesButton),
				),
			);
			guard('settings section', () =>
				ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'image-manager', order: 45, label: () => '图片管理' }, SettingsSection)),
			);
			guard('manager modal', () => ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'image-manager-modal' }, ManagerModal)));
		}

		exports.buildSessionRows = buildSessionRows;
		exports.apply = apply;
		exports.inject = inject;
		exports.name = PANEL_ID;
		return module.exports;
	},
});

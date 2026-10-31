import { JSDOM } from 'jsdom';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import yaml from 'js-yaml';

// A deliberately small Obsidian API host. It executes the actual bundled plugin UI,
// including its command registration, vault events, persistence and HTTP adapter.
export async function createHost(bundle, shared = {}, responder = async () => { throw new Error('Network is disabled in this host'); }, dictionaryResponder = async () => ({ status: 404, text: '{}' }), audioResponder = async () => { const bytes=new Uint8Array(128); bytes.set([0x49,0x44,0x33]); return {status:200,headers:{'content-type':'audio/mpeg'},arrayBuffer:bytes.buffer}; }) {
  const dom = new JSDOM('<main id="app"></main>', { url: 'https://obsidian.invalid', runScripts: 'outside-only' });
  const win = dom.window, document = win.document;
  Object.defineProperty(win, 'crypto', { value: webcrypto });
  win.TextEncoder = TextEncoder; win.TextDecoder = TextDecoder;
  win.Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
  const state = { files: new Map(), folders: new Set(), settings: null, ...shared };
  const notices = [], requests = [], pronunciationRequests = [], audioRequests = [], commands = new Map(), factories = new Map(), leaves = [];
  const audioObjects=new Map(); let audioSequence=0;
  win.URL.createObjectURL=blob=>{const url=`blob:english-flow-test-${++audioSequence}`;audioObjects.set(url,blob);return url;};
  win.URL.revokeObjectURL=url=>audioObjects.delete(url);
  const proto = win.HTMLElement.prototype;
  proto.empty = function () { this.replaceChildren(); };
  proto.setText = function (text) { this.textContent = text; };
  proto.addClass = function (...classes) { this.classList.add(...classes); };
  proto.removeClass = function (...classes) { this.classList.remove(...classes); };
  proto.createEl = function (tag, options = {}) {
    const el = document.createElement(tag);
    if (options.cls) el.className = options.cls;
    if (options.text !== undefined) el.textContent = options.text;
    if (options.value !== undefined) el.value = options.value;
    for (const [name, value] of Object.entries(options.attr ?? {})) el.setAttribute(name, value);
    this.append(el); return el;
  };
  proto.createDiv = function (options) { return this.createEl('div', options); };
  const root = document.getElementById('app');
  function emitter() {
    const listeners = new Map();
    return {
      on(name, callback) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(callback); return { name, callback }; },
      emit(name, ...args) { for (const callback of listeners.get(name) ?? []) callback(...args); }
    };
  }
  class TFile { constructor(path) { this.path = path; } }
  const vaultEvents = emitter(), workspaceEvents = emitter();
  const vault = {
    ...vaultEvents,
    getMarkdownFiles: () => [...state.files.keys()].filter(path => path.endsWith('.md')).map(path => new TFile(path)),
    getFileByPath: path => state.files.has(path) ? new TFile(path) : null,
    getAbstractFileByPath: path => state.files.has(path) ? new TFile(path) : state.folders.has(path) ? { path } : null,
    read: async file => { if (!state.files.has(file.path)) throw new Error('missing'); return state.files.get(file.path); },
    createFolder: async path => { if (state.folders.has(path)) throw new Error('exists'); state.folders.add(path); return { path }; },
    create: async (path, text) => {
      if (state.files.has(path)) throw new Error('exists');
      state.files.set(path, text); const file = new TFile(path); vaultEvents.emit('create', file); return file;
    }
  };
  class WorkspaceLeaf {
    constructor() { this.view = null; leaves.push(this); }
    async setViewState(value) { this.view = factories.get(value.type)(this); await this.view.onOpen(); }
    async loadIfDeferred() {}
    async openFile(file, options) { this.opened = { path: file.path, options }; }
  }
  const workspace = {
    ...workspaceEvents,
    getLeavesOfType: type => leaves.filter(leaf => leaf.view?.getViewType() === type),
    getActiveViewOfType: () => workspace.activeFileView ?? null,
    getActiveFile: () => workspace.activeFileView?.file ?? null,
    activeEditor: null,
    getRightLeaf: () => new WorkspaceLeaf(), getLeaf: () => new WorkspaceLeaf(),
    revealLeaf: async () => {}
  };
  const app = { vault, workspace, secretStorage: { getSecret: name => name === 'english-reading-flow' ? 'host-test-secret' : null } };
  class Plugin {
    constructor(app, manifest) { this.app = app; this.manifest = manifest; }
    async loadData() { return state.settings; }
    async saveData(settings) { state.settings = structuredClone(settings); }
    registerView(type, factory) { factories.set(type, factory); }
    addSettingTab() {}
    addRibbonIcon() { return root.createEl('button'); }
    addCommand(command) { commands.set(command.id, command); }
    registerEvent() {}
    registerDomEvent(target, event, callback) { target.addEventListener(event, callback); }
  }
  class ItemView {
    constructor(leaf) { this.leaf = leaf; this.app = app; this.containerEl = root.createDiv(); this.contentEl = this.containerEl.createDiv(); }
  }
  class ButtonComponent {
    constructor(container) { this.buttonEl = container.createEl('button', { attr: { type: 'button' } }); }
    setButtonText(value) { this.buttonEl.textContent = value; return this; }
    setCta() { this.buttonEl.classList.add('mod-cta'); return this; }
    setDisabled(value) { this.buttonEl.disabled = value; return this; }
    onClick(callback) { this.buttonEl.addEventListener('click', callback); return this; }
  }
  class InputComponent {
    constructor(container, toggle = false) { this.inputEl = container.createEl('input', { attr: { type: toggle ? 'checkbox' : 'text' } }); this.toggle = toggle; }
    setValue(value) { if (this.toggle) this.inputEl.checked = value; else this.inputEl.value = value; return this; }
    setPlaceholder(value) { this.inputEl.placeholder = value; return this; }
    onChange(callback) { this.inputEl.addEventListener(this.toggle ? 'change' : 'input', () => callback(this.toggle ? this.inputEl.checked : this.inputEl.value)); return this; }
  }
  class Setting {
    constructor(el) { this.el = el.createDiv({ cls: 'setting-item' }); this.controls = this.el.createDiv(); }
    setName(text) { this.el.createEl('strong', { text }); return this; }
    setDesc(text) { this.el.createEl('p', { text }); return this; }
    addText(callback) { callback(new InputComponent(this.controls)); return this; }
    addToggle(callback) { callback(new InputComponent(this.controls, true)); return this; }
    addComponent(callback) { callback(this.controls); return this; }
  }
  class SecretComponent extends InputComponent { constructor(_app, container) { super(container); } }
  class Modal {
    constructor(app) { this.app = app; this.modalEl = root.createDiv({ cls: 'modal' }); this.contentEl = this.modalEl.createDiv({ cls: 'modal-content' }); }
    setTitle(text) { this.modalEl.setAttribute('aria-label', text); return this; }
    open() { this.onOpen(); }
    close() { this.onClose?.(); this.modalEl.remove(); }
  }
  class PluginSettingTab { constructor(app) { this.app = app; this.containerEl = root.createDiv(); } }
  class Notice { constructor(message) { notices.push(message); } }
  const obsidian = {
    Plugin, ItemView, FileView: ItemView, ButtonComponent, Setting, SecretComponent, Modal, PluginSettingTab, Notice, WorkspaceLeaf, TFile,
    Platform: { isMobile: false }, parseYaml: yaml.load, stringifyYaml: value => yaml.dump(value, { noRefs: true, lineWidth: -1 }),
    setIcon: (element, name) => { element.setAttribute('data-icon', name); },
    requestUrl: async request => {
      if (request.url.startsWith('https://api.dictionaryapi.dev/')) { pronunciationRequests.push(request); return dictionaryResponder(request); }
      if (['dict.youdao.com','translate.google.com'].includes(new URL(request.url).hostname)) { audioRequests.push(request); return audioResponder(request); }
      requests.push(request); return responder(request);
    }
  };
  win.module = { exports: {} };
  win.exports = win.module.exports;
  win.require = name => { if (name !== 'obsidian') throw new Error(`Unexpected runtime dependency: ${name}`); return obsidian; };
  vm.runInContext(bundle, dom.getInternalVMContext(), { filename: 'english-reading-flow/main.js' });
  const PluginClass = win.module.exports.default;
  const plugin = new PluginClass(app, { id: 'english-reading-flow', version: '0.1.0' });
  await plugin.onload();
  const view = () => plugin.readingPopover?.panel ?? leaves.find(leaf => leaf.view?.getViewType() === 'english-reading-flow-view')?.view.panel;
  function buttons(label) { return [...view().contentEl.querySelectorAll('button')].filter(b => b.getAttribute('aria-label') === label || b.textContent === label || b.textContent.startsWith(label)); }
  async function click(label, index = 0) {
    const b = buttons(label)[index];
    if (!b) throw new Error(`Button not found: ${label}`);
    if (b.disabled) throw new Error(`Button disabled: ${label}`);
    b.click(); await settle();
  }
  async function settle() { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)); }
  function input(value) {
    const el = view().contentEl.querySelector('textarea');
    if (!el || el.disabled) throw new Error('Editable answer field not found');
    el.value = value; el.dispatchEvent(new win.Event('input', { bubbles: true }));
  }
  async function close() { if (plugin.readingPopover) plugin.readingPopover.close(); else if (view()) await view().onClose(); dom.window.close(); }
  return { plugin, app, state, notices, requests, pronunciationRequests, audioRequests, audioObjects, commands, dom, view, click, input, settle, close };
}

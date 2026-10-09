import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { Window } from "happy-dom";
import type { Note } from "../src/note-editor.js";

// In-process component tests only: no real browser, network, or user data.
const dom = new Window({ url: "https://relay.example/", settings: {
  enableJavaScriptEvaluation: false,
  disableJavaScriptFileLoading: true,
  disableCSSFileLoading: true,
  navigation: { disableMainFrameNavigation: true, disableChildFrameNavigation: true, disableChildPageNavigation: true },
} });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Event", "MouseEvent", "KeyboardEvent", "CompositionEvent", "File", "Blob", "FormData", "XMLHttpRequest", "localStorage"] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom : dom[key] });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: App } = await import("../src/App.js");
after(async () => { await dom.happyDOM.close(); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }

async function setup(t: TestContext, configure?: (fixture: { notes: Map<string, Note>; control: { before(method: string, url: string, signal?: AbortSignal | null): Promise<void>; failSave: boolean; loseCreateResponse: boolean; files: Array<Record<string, unknown>>; ocrText: string; ocrStatus: number } }) => void, notebook = true) {
  dom.happyDOM.setURL(`https://relay.example/${notebook ? "#notebook" : ""}`);
  const notes = new Map<string, Note>(["a", "b"].map((id) => [id, {
    id, title: `Test ${id.toUpperCase()}`, content: `Original ${id.toUpperCase()}`, attachments: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  }]));
  const requests: Array<{ method: string; url: string; body: Record<string, any> }> = [];
  const control = { before: async (_method: string, _url: string, _signal?: AbortSignal | null) => {}, failSave: false, loseCreateResponse: false, files: [] as Array<Record<string, unknown>>, ocrText: "", ocrStatus: 200 };
  configure?.({ notes, control });
  let clipboard = { content: "", updatedAt: null as string | null };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    requests.push({ method, url, body });
    await control.before(method, url, init?.signal);
    const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    if (url === "/api/state") return response({ clipboard, files: control.files, limits: { maxUploadBytes: 1000 }, storage: { usedBytes: 0, maxBytes: 20 * 1024 ** 3 } });
    if (url === "/api/clipboard" && method === "PUT") {
      clipboard = { content: body.content, updatedAt: new Date().toISOString() };
      return response({ clipboard });
    }
    if (url === "/api/files/archive" && method === "POST") return response({ url: "/api/files/archive/test-ticket" }, 201);
    if (/^\/api\/files\/[^/]+\/ocr$/.test(url) && method === "POST") return control.ocrStatus === 200
      ? response({ text: control.ocrText })
      : response({ error: "Test OCR failed" }, control.ocrStatus);
    if (url === "/api/notes" && method === "GET") return response({ notes: [...notes.values()].map(({ content, attachments, ...note }) => ({ ...note, preview: content, characters: content.length, attachmentCount: attachments.length })) });
    if (url.startsWith("/api/notes")) {
      const id = method === "POST" ? body.id : url.split("/").pop()!;
      if (method === "GET") return notes.has(id) ? response({ note: notes.get(id) }) : response({ error: "Not found" }, 404);
      if (control.failSave) return response({ error: "Test save failed" }, 503);
      if (method === "POST" && notes.has(id)) return response({ note: notes.get(id) });
      if (method === "PUT" && !notes.has(id)) return response({ error: "Not found" }, 404);
      const note: Note = { id, title: body.title?.trim() || body.content.split("\n").find((line) => line.trim()) || "未命名笔记", content: body.content, attachments: body.attachments ?? notes.get(id)?.attachments ?? [], createdAt: notes.get(id)?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() };
      notes.set(id, note);
      if (method === "POST" && control.loseCreateResponse) {
        control.loseCreateResponse = false;
        return response({ error: "Test create response lost" }, 503);
      }
      return response({ note }, method === "POST" ? 201 : 200);
    }
    throw new Error(`Unexpected test request: ${method} ${url}`);
  }) as typeof fetch;
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  });
  await act(async () => root.render(createElement(App)));
  return { notes, requests, control, container };
}

function field(label: string) {
  const element = dom.document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`);
  assert.ok(element, `Missing input: ${label}`);
  return element;
}

async function type(label: string, value: string) {
  await act(async () => {
    const element = field(label);
    const prototype = element.tagName === "TEXTAREA" ? dom.HTMLTextAreaElement.prototype : dom.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
}

async function click(selector: string) {
  const element = dom.document.querySelector(selector);
  assert.ok(element, `Missing button: ${selector}`);
  await act(async () => { element.click(); });
  await flush();
}

async function openNote(title: string) {
  const button = [...dom.document.querySelectorAll(".note-item")].find((item) => item.querySelector("strong")?.textContent === title);
  assert.ok(button);
  await act(async () => { button.click(); });
}

const footer = () => dom.document.querySelector(".note-editor-footer")?.textContent;
const editorVisible = () => !dom.document.querySelector(".notebook")?.hasAttribute("hidden");

// Drive only autosave/backoff timers; request timeouts and other UI timers stay real.
function autosaveClock(t: TestContext) {
  const originalSet = dom.setTimeout;
  const originalClear = dom.clearTimeout;
  const pending = new Map<number, { run: () => void; delay: number }>();
  let id = -1;
  dom.setTimeout = ((run: () => void, delay: number, ...args: unknown[]) => {
    if (delay === 2_000 || (delay > 9_000 && delay <= 10_000) || (delay > 19_000 && delay <= 20_000) || (delay > 29_000 && delay <= 30_000)) {
      pending.set(id, { run, delay });
      return id--;
    }
    return originalSet(run, delay, ...args);
  }) as typeof dom.setTimeout;
  dom.clearTimeout = ((timer: number) => { pending.delete(timer); originalClear(timer); }) as typeof dom.clearTimeout;
  t.after(() => { dom.setTimeout = originalSet; dom.clearTimeout = originalClear; });
  return {
    pending,
    async fire() {
      assert.equal(pending.size, 1, "exactly one autosave timer should be active");
      const [timer, job] = [...pending][0];
      pending.delete(timer);
      await act(async () => { job.run(); });
      await flush();
    },
  };
}

test("autosave waits for a pause, stays silent, and survives reopening the notebook", async (t) => {
  const { notes, requests } = await setup(t);
  const clock = autosaveClock(t);
  await openNote("Test A");
  await type("笔记内容", "First keystrokes");
  const firstTimer = [...clock.pending.keys()][0];
  await type("笔记内容", "The finished sentence");
  assert.equal(clock.pending.has(firstTimer), false);
  assert.equal(notes.get("a")?.content, "Original A");
  await clock.fire();
  assert.equal(notes.get("a")?.content, "The finished sentence");
  assert.equal(requests.filter((request) => request.method === "PUT").length, 1);
  assert.equal(dom.document.querySelector(".toast"), null);
  assert.match(footer()!, /已保存/);
  assert.equal(clock.pending.size, 0);
  await click('[aria-label="返回中转首页"]');
  await click('[aria-label="打开记事本"]');
  await openNote("Test A");
  assert.equal(field("笔记内容").value, "The finished sentence");
});

test("autosave waits for Chinese composition and preserves typing during a slow save", async (t) => {
  const { notes, control } = await setup(t);
  const clock = autosaveClock(t);
  await openNote("Test A");
  await act(async () => { field("笔记内容").dispatchEvent(new dom.CompositionEvent("compositionstart", { bubbles: true }) as unknown as Event); });
  await type("笔记内容", "中文");
  assert.equal(clock.pending.size, 0);
  await act(async () => { field("笔记内容").dispatchEvent(new dom.CompositionEvent("compositionend", { bubbles: true }) as unknown as Event); });
  const gate = deferred();
  control.before = async (method) => { if (method === "PUT") await gate.promise; };
  await clock.fire();
  assert.equal(field("笔记内容").disabled, false);
  assert.equal(dom.document.querySelector<HTMLButtonElement>('.note-item')?.disabled, false);
  await type("笔记内容", "中文后面继续输入");
  assert.equal(clock.pending.size, 0);
  gate.resolve();
  await flush();
  assert.equal(notes.get("a")?.content, "中文");
  assert.equal(field("笔记内容").value, "中文后面继续输入");
  await clock.fire();
  assert.equal(notes.get("a")?.content, "中文后面继续输入");
});

test("automatic retries recover a lost create response without duplicating a note", async (t) => {
  const { notes, requests, control } = await setup(t);
  const clock = autosaveClock(t);
  await click('.notebook-heading .primary');
  assert.equal(clock.pending.size, 0);
  await type("笔记内容", "First version");
  control.loseCreateResponse = true;
  await clock.fire();
  assert.equal(notes.size, 3);
  assert.match(footer()!, /保存失败/);
  assert.ok([...clock.pending.values()][0].delay > 9_000);
  await type("笔记内容", "New version while offline");
  await clock.fire();
  const creates = requests.filter((request) => request.method === "POST");
  assert.equal(notes.size, 3);
  assert.deepEqual(creates[0].body, creates[1].body);
  assert.equal(notes.get(creates[0].body.id)?.content, "New version while offline");
  assert.match(footer()!, /已保存/);
});

test("switching notes cancels the old timer and attachment removal also autosaves", async (t) => {
  const image = { id: "image-autosave", name: "sample.png", size: 10, mime: "image/png", createdAt: "2026-01-01T00:00:00Z", hasThumbnail: true };
  const { notes, requests } = await setup(t, ({ notes, control }) => {
    notes.set("a", { ...notes.get("a")!, attachments: [image.id] });
    control.files = [image];
  });
  const clock = autosaveClock(t);
  await openNote("Test A");
  await click('[aria-label="从笔记移除 sample.png"]');
  await clock.fire();
  assert.deepEqual(notes.get("a")?.attachments, []);
  await type("笔记内容", "Before switch");
  await openNote("Test B");
  assert.equal(clock.pending.size, 0);
  assert.equal(notes.get("a")?.content, "Before switch");
  assert.equal(notes.get("b")?.content, "Original B");
  assert.equal(requests.filter((request) => request.method === "PUT" && request.url === "/api/notes/b").length, 0);
});

test("unsaved edits guard page reload, and a successful automatic save releases it", async (t) => {
  const { control } = await setup(t);
  const clock = autosaveClock(t);
  await openNote("Test A");
  await type("笔记内容", "Not yet saved");
  const before = new dom.Event("beforeunload", { cancelable: true });
  dom.dispatchEvent(before);
  assert.equal(before.defaultPrevented, true);
  control.failSave = true;
  await clock.fire();
  assert.equal(field("笔记内容").value, "Not yet saved");
  control.failSave = false;
  await act(async () => { dom.dispatchEvent(new dom.Event("online")); });
  await flush();
  const afterSave = new dom.Event("beforeunload", { cancelable: true });
  dom.dispatchEvent(afterSave);
  assert.equal(afterSave.defaultPrevented, false);
  assert.equal(clock.pending.size, 0);
});

test("quota failures stop automatic retries and undoing back to saved text clears the error", async (t) => {
  const { control, notes } = await setup(t);
  const { ApiError } = await import("../src/api.js");
  const clock = autosaveClock(t);
  await openNote("Test A");
  control.before = async (method) => { if (method === "PUT") throw new ApiError("空间已满", 507); };
  await type("笔记内容", "Cannot fit");
  await clock.fire();
  assert.equal(clock.pending.size, 0);
  assert.equal(notes.get("a")?.content, "Original A");
  assert.match(footer()!, /保存失败/);
  await type("笔记内容", "Original A");
  assert.equal(clock.pending.size, 0);
  assert.match(footer()!, /已保存/);
  assert.equal(dom.document.querySelector(".notebook-error"), null);
});

test("clipboard save is kept in the footer while save-to-notebook stays in the heading", async (t) => {
  const { container } = await setup(t, undefined, false);
  await flush();
  const save = container.querySelector('[aria-label="保存或刷新剪贴板"]');
  const saveToNotebook = container.querySelector(".clipboard-note-save");
  assert.ok(save?.closest(".clipboard-footer"));
  assert.ok(saveToNotebook?.closest(".card-heading"));
});

test("ordinary mode pastes multiple files into the transfer area without intercepting text", async (t) => {
  const { control } = await setup(t, undefined, false);
  const uploadedNames: string[] = [];
  const originalXHR = globalThis.XMLHttpRequest;
  class FakeXHR {
    upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
    status = 201;
    responseText = "";
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    open() {}
    setRequestHeader() {}
    abort() { this.onabort?.(); }
    send(body: FormData) {
      const file = body.get("file") as globalThis.File;
      uploadedNames.push(file.name);
      const relayFile = {
        id: `file-${uploadedNames.length}`,
        name: file.name,
        size: file.size,
        mime: file.type,
        createdAt: "2026-01-01T00:00:00Z",
        hasThumbnail: false,
      };
      this.responseText = JSON.stringify({ file: relayFile });
      control.files.push(relayFile);
      queueMicrotask(() => this.onload?.());
    }
  }
  Object.defineProperty(globalThis, "XMLHttpRequest", { configurable: true, value: FakeXHR });
  t.after(() => { Object.defineProperty(globalThis, "XMLHttpRequest", { configurable: true, value: originalXHR }); });

  const textPaste = new dom.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(textPaste, "clipboardData", { value: { files: [], items: [] } });
  await act(async () => { dom.dispatchEvent(textPaste); });
  assert.equal(textPaste.defaultPrevented, false);

  const pdf = new dom.File(["pdf"], "课程讲义.pdf", { type: "application/pdf" });
  const archive = new dom.File(["zip"], "项目.zip", { type: "application/zip" });
  const filePaste = new dom.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(filePaste, "clipboardData", { value: { files: [pdf, archive], items: [] } });
  await act(async () => { dom.dispatchEvent(filePaste); });
  await flush();
  await flush();

  assert.equal(filePaste.defaultPrevented, true);
  assert.deepEqual(uploadedNames, ["课程讲义.pdf", "项目.zip"]);
  assert.equal(control.files.length, 2);
});

test("ordinary file paste stays disabled while the notebook is open", async (t) => {
  await setup(t);
  const file = new dom.File(["pdf"], "note-source.pdf", { type: "application/pdf" });
  const event = new dom.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files: [file], items: [] } });
  await act(async () => { dom.dispatchEvent(event); });
  assert.equal(event.defaultPrevented, false);
});

test("slow note switches preserve newly typed text and a later click saves it before switching", async (t) => {
  const { notes, control } = await setup(t);
  await openNote("Test A");
  const gate = deferred();
  control.before = async (method, url) => { if (method === "GET" && url === "/api/notes/b") await gate.promise; };
  await openNote("Test B");
  assert.equal(field("笔记内容").disabled, false);
  await type("笔记内容", "Typed during loading");
  gate.resolve();
  await flush();
  assert.equal(field("笔记标题").value, "Test A");
  assert.equal(field("笔记内容").value, "Typed during loading");
  assert.match(footer()!, /未保存/);
  await openNote("Test B");
  assert.equal(notes.get("a")?.content, "Typed during loading");
  assert.equal(field("笔记内容").value, "Original B");
});

test("refresh updates the selected note but never replaces dirty text or typing during a refresh", async (t) => {
  const { notes, control } = await setup(t);
  await openNote("Test A");
  notes.set("a", { ...notes.get("a")!, content: "Updated on another device" });
  await click('[aria-label="刷新笔记列表"]');
  assert.equal(field("笔记内容").value, "Updated on another device");
  await type("笔记内容", "Local draft");
  notes.set("a", { ...notes.get("a")!, content: "Another remote update" });
  await click('[aria-label="刷新笔记列表"]');
  assert.equal(field("笔记内容").value, "Local draft");
  await click('.note-editor-actions .primary');
  const gate = deferred();
  control.before = async (method, url) => { if (method === "GET" && url === "/api/notes/a") await gate.promise; };
  await click('[aria-label="刷新笔记列表"]');
  await type("笔记内容", "Typed during refresh");
  gate.resolve();
  await flush();
  assert.equal(field("笔记内容").value, "Typed during refresh");
});

test("both return buttons and hash navigation save edits through the same guard", async (t) => {
  const { notes } = await setup(t);
  for (const [index, selector] of ['[aria-label="返回中转首页"]', '.notebook-heading .ghost', null].entries()) {
    await openNote("Test A");
    await type("笔记内容", `Saved via return ${index}`);
    if (selector) await click(selector);
    else {
      await act(async () => { dom.location.hash = ""; dom.dispatchEvent(new dom.HashChangeEvent("hashchange")); });
      await flush();
    }
    assert.equal(notes.get("a")?.content, `Saved via return ${index}`);
    assert.equal(editorVisible(), false);
    if (index !== 2) await click('[aria-label="打开记事本"]');
  }
});

test("a failed return save keeps the editor, URL, and draft intact, then retries normally", async (t) => {
  const { control, notes } = await setup(t);
  await openNote("Test A");
  await type("笔记内容", "Must stay here");
  control.failSave = true;
  await click('[aria-label="返回中转首页"]');
  assert.equal(editorVisible(), true);
  assert.equal(dom.location.hash, "#notebook");
  assert.equal(field("笔记内容").value, "Must stay here");
  assert.equal(notes.get("a")?.content, "Original A");
  control.failSave = false;
  await click('.notebook-heading .ghost');
  assert.equal(editorVisible(), false);
  assert.equal(notes.get("a")?.content, "Must stay here");
});

test("typing during an active save keeps the latest draft and cancels an unsafe return", async (t) => {
  const { control, notes } = await setup(t);
  await openNote("Test A");
  await type("笔记内容", "Submitted text");
  const gate = deferred();
  control.before = async (method) => { if (method === "PUT") await gate.promise; };
  await click('.note-editor-actions .primary');
  await click('[aria-label="返回中转首页"]');
  await type("笔记内容", "Newer typing");
  gate.resolve();
  await flush();
  assert.equal(editorVisible(), true);
  assert.equal(dom.location.hash, "#notebook");
  assert.equal(field("笔记内容").value, "Newer typing");
  assert.equal(notes.get("a")?.content, "Submitted text");
  await click('[aria-label="返回中转首页"]');
  assert.equal(notes.get("a")?.content, "Newer typing");
  assert.equal(editorVisible(), false);
});

test("new blank notes never create records, while title-only notes save on return", async (t) => {
  const { notes, requests } = await setup(t);
  await click('.notebook-heading .primary');
  await click('[aria-label="返回中转首页"]');
  assert.equal(notes.size, 2);
  assert.equal(requests.filter((request) => request.method === "POST").length, 0);
  await click('[aria-label="打开记事本"]');
  await click('.notebook-heading .primary');
  await type("笔记标题", "Title only");
  await click('.notebook-heading .ghost');
  assert.equal(notes.size, 3);
  assert.ok([...notes.values()].some((note) => note.title === "Title only" && note.content === ""));
});

test("retrying a lost create response uses one ID and preserves subsequent edits", async (t) => {
  const { notes, requests, control } = await setup(t);
  await click('.notebook-heading .primary');
  await type("笔记内容", "First draft");
  control.loseCreateResponse = true;
  await click('.note-editor-actions .primary');
  assert.equal(notes.size, 3);
  await type("笔记内容", "Edited after lost response");
  await click('.note-editor-actions .primary');
  assert.equal(notes.size, 3);
  const creates = requests.filter((request) => request.method === "POST");
  assert.equal(creates.length, 2);
  assert.deepEqual(creates[0].body, creates[1].body);
  assert.equal(notes.get(creates[0].body.id)?.content, "Edited after lost response");
  assert.equal(field("笔记内容").value, "Edited after lost response");
  assert.match(footer()!, /已保存/);
});

test("Chinese composition prevents late reads from replacing the editor", async (t) => {
  const { control } = await setup(t);
  await openNote("Test A");
  const gate = deferred();
  control.before = async (method, url) => { if (method === "GET" && url === "/api/notes/b") await gate.promise; };
  await openNote("Test B");
  await act(async () => { field("笔记内容").dispatchEvent(new dom.CompositionEvent("compositionstart", { bubbles: true }) as unknown as Event); });
  gate.resolve();
  await flush();
  assert.equal(field("笔记标题").value, "Test A");
  await act(async () => { field("笔记内容").dispatchEvent(new dom.CompositionEvent("compositionend", { bubbles: true, data: "中文" }) as unknown as Event); });
  await type("笔记内容", "中文输入已保留");
  await click('.note-editor-actions .primary');
  assert.equal(field("笔记内容").value, "中文输入已保留");
});

test("note timeouts release the save action and preserve the current draft", async (t) => {
  const { control } = await setup(t);
  await openNote("Test A");
  await type("笔记内容", "Keep on timeout");
  const setTimeout = dom.setTimeout;
  dom.setTimeout = ((handler: () => void, timeout: number) => setTimeout(handler, timeout === 15_000 ? 20 : timeout)) as typeof dom.setTimeout;
  t.after(() => { dom.setTimeout = setTimeout; });
  control.before = async (method, _url, signal) => {
    if (method === "PUT") await new Promise<void>((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(new Error("Test aborted request")), { once: true });
    });
  };
  await click('.note-editor-actions .primary');
  await act(async () => { await new Promise((resolve) => globalThis.setTimeout(resolve, 40)); });
  assert.equal(field("笔记内容").value, "Keep on timeout");
  assert.match(dom.document.querySelector('.notebook-error')?.textContent ?? "", /连接超时/);
  assert.equal(dom.document.querySelector<HTMLButtonElement>('.note-editor-actions .primary')?.disabled, false);
});

test("a manual file refresh takes over an older state read instead of silently doing nothing", async (t) => {
  let first = true;
  const { requests } = await setup(t, ({ control }) => {
    control.before = async (method, url, signal) => {
      if (first && method === "GET" && url === "/api/state") {
        first = false;
        await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("superseded")), { once: true }));
      }
    };
  }, false);
  assert.match(dom.document.body.textContent ?? "", /正在读取/);
  await click('[aria-label="刷新文件列表"]');
  assert.doesNotMatch(dom.document.body.textContent ?? "", /正在读取/);
  assert.equal(dom.document.querySelector<HTMLButtonElement>('[aria-label="刷新文件列表"]')?.disabled, false);
  assert.equal(requests.filter((request) => request.method === "GET" && request.url === "/api/state").length, 2);
});

test("saving the clipboard during the initial read starts a replacement read and releases the file list", async (t) => {
  let first = true;
  const { requests } = await setup(t, ({ control }) => {
    control.before = async (method, url, signal) => {
      if (first && method === "GET" && url === "/api/state") {
        first = false;
        await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("cancelled for write")), { once: true }));
      }
    };
  }, false);
  await type("共享剪贴板内容", "Save while loading");
  await click('[aria-label="保存或刷新剪贴板"]');
  await flush();
  assert.doesNotMatch(dom.document.body.textContent ?? "", /正在读取/);
  assert.equal(requests.filter((request) => request.method === "GET" && request.url === "/api/state").length, 2);
});

test("file thumbnails open the same original-image preview while download remains separate", async (t) => {
  const image = { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", name: "shared.png", size: 10, mime: "image/png", createdAt: "2026-01-01T00:00:00Z", hasThumbnail: true };
  const { requests } = await setup(t, ({ control }) => { control.files = [image]; control.ocrText = "Selectable OCR text"; }, false);
  await flush();
  assert.equal(dom.document.querySelector<HTMLImageElement>('.file-thumbnail img')?.getAttribute("src"), `/api/files/${image.id}/thumbnail`);
  assert.equal(dom.document.querySelector<HTMLAnchorElement>(`a[aria-label="下载 ${image.name}"]`)?.getAttribute("href"), `/api/files/${image.id}/download`);
  await click('.file-thumbnail-button');
  assert.equal(dom.document.querySelector('.image-lightbox')?.getAttribute("aria-label"), `查看原图 ${image.name}`);
  const preview = dom.document.querySelector<HTMLImageElement>('.image-lightbox img');
  assert.equal(preview?.getAttribute("src"), `/api/files/${image.id}/preview?attempt=0`);
  await act(async () => { preview?.dispatchEvent(new dom.Event("load")); });
  await flush();
  const ocrText = dom.document.querySelector<HTMLTextAreaElement>('[aria-label="可选择的图片识别文字"]');
  assert.equal(ocrText?.value, "Selectable OCR text");
  assert.equal(ocrText?.readOnly, true);
  assert.equal(dom.document.querySelector<HTMLButtonElement>('[aria-label="复制图片识别文字"]')?.disabled, false);
  assert.equal(requests.filter((request) => request.url === `/api/files/${image.id}/ocr`).length, 1);
  assert.doesNotMatch(dom.document.querySelector(".image-lightbox")?.textContent ?? "", /shared\.png/);
  await click('[aria-label="查看原始尺寸"]');
  assert.ok(dom.document.querySelector('.image-lightbox')?.classList.contains("is-zoomed"));
  await click('[aria-label="关闭原图预览"]');
  assert.equal(dom.document.querySelector('.image-lightbox'), null);
});

test("selected files can be downloaded individually or together as a streamed archive", async (t) => {
  const files = [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "first.txt", size: 5, mime: "text/plain", createdAt: "2026-01-01T00:00:00Z", hasThumbnail: false },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "second.txt", size: 6, mime: "text/plain", createdAt: "2026-01-02T00:00:00Z", hasThumbnail: false },
  ];
  const downloads: string[] = [];
  const originalClick = dom.HTMLAnchorElement.prototype.click;
  dom.HTMLAnchorElement.prototype.click = function clickDownload() { downloads.push(this.getAttribute("href") ?? ""); };
  t.after(() => { dom.HTMLAnchorElement.prototype.click = originalClick; });
  const { requests } = await setup(t, ({ control }) => { control.files = files; }, false);
  await flush();

  await click('[aria-label="选择 first.txt"]');
  assert.equal(dom.document.querySelector(".batch-download")?.getAttribute("aria-label"), "下载 1 项");
  await click(".batch-download");
  assert.deepEqual(downloads, [`/api/files/${files[0].id}/download`]);
  assert.equal(requests.filter((request) => request.url === "/api/files/archive").length, 0);

  await click('[aria-label="选择 second.txt"]');
  assert.equal(dom.document.querySelector(".batch-download")?.getAttribute("aria-label"), "下载 2 项");
  await click(".batch-download");
  assert.equal(downloads.at(-1), "/api/files/archive/test-ticket");
  const request = requests.find((item) => item.url === "/api/files/archive");
  assert.equal(request?.method, "POST");
  assert.deepEqual(new Set(request?.body.ids), new Set(files.map((file) => file.id)));
});

test("file rows support range selection, mixed select-all, visible-only filtering, and escape", async (t) => {
  const files = ["A.pdf", "B.pdf", "C.zip"].map((name, index) => ({ id: `file-${index}`, name, size: 10, mime: "application/octet-stream", createdAt: `2026-01-0${index + 1}T00:00:00Z`, hasThumbnail: false }));
  await setup(t, ({ control }) => { control.files = files; }, false);
  await flush();
  const rows = [...dom.document.querySelectorAll<HTMLElement>(".file-row")];
  await act(async () => { rows[0].click(); });
  assert.equal(field("选择 C.zip").checked, true);
  assert.equal(field("全选文件").indeterminate, true);
  await act(async () => { rows[2].dispatchEvent(new dom.MouseEvent("click", { bubbles: true, shiftKey: true }) as unknown as Event); });
  assert.equal(dom.document.querySelectorAll('.row-select input:checked').length, 3);
  assert.equal(field("全选文件").indeterminate, false);
  assert.equal(field("全选文件").checked, true);
  await type("搜索文件", ".pdf");
  assert.match(dom.document.querySelector('.selection-hidden')?.textContent ?? "", /含 1 项/);
  await click('[aria-label="全选搜索结果"]');
  assert.equal(dom.document.querySelectorAll('.row-select input:checked').length, 0);
  assert.match(dom.document.querySelector('.selection-count')?.textContent ?? "", /已选 1 项/);
  await type("搜索文件", "no matches");
  assert.equal(dom.document.querySelector<HTMLButtonElement>('.batch-download')?.disabled, false);
  await click('[aria-label="取消选择"]');
  assert.equal(dom.document.querySelector<HTMLButtonElement>('.batch-download')?.disabled, true);
  await type("搜索文件", "");
  await click('[aria-label="选择 A.pdf"]');
  await act(async () => { field("选择 A.pdf").dispatchEvent(new dom.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }) as unknown as Event); });
  assert.equal(dom.document.querySelectorAll('.row-select input:checked').length, 0);
});

test("rename actions do not change selection and Enter during Chinese composition cannot save a name", async (t) => {
  const file = { id: "rename-test", name: "draft.txt", size: 10, mime: "text/plain", createdAt: "2026-01-01T00:00:00Z", hasThumbnail: false };
  const { requests } = await setup(t, ({ control }) => { control.files = [file]; }, false);
  await flush();
  await click('[aria-label="选择 draft.txt"]');
  await click('[aria-label="重命名 draft.txt"]');
  assert.equal(field("选择 draft.txt").checked, true);
  await type("修改 draft.txt 的文件名", "笔记.txt");
  await act(async () => { field("修改 draft.txt 的文件名").dispatchEvent(new dom.KeyboardEvent("keydown", { bubbles: true, key: "Enter", isComposing: true }) as unknown as Event); });
  assert.equal(requests.some((request) => request.method === "PATCH"), false);
  await act(async () => { field("修改 draft.txt 的文件名").dispatchEvent(new dom.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }) as unknown as Event); });
  assert.equal(dom.document.querySelector('.rename-input'), null);
  assert.equal(field("选择 draft.txt").checked, true);
});

test("confirmed uploads appear and dismiss individually before the batch or refresh finishes", async (t) => {
  const { control } = await setup(t, undefined, false);
  await flush();
  const requests: FakeXHR[] = [];
  const originalXHR = globalThis.XMLHttpRequest;
  class FakeXHR {
    upload: { onprogress: ((event: Partial<ProgressEvent>) => void) | null; onload: (() => void) | null } = { onprogress: null, onload: null };
    status = 201;
    responseText = "";
    file!: globalThis.File;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    open() {}
    setRequestHeader() {}
    abort() { this.onabort?.(); }
    send(body: FormData) { this.file = body.get("file") as globalThis.File; requests.push(this); }
    finish() {
      const file = { id: `uploaded-${requests.indexOf(this)}`, name: this.file.name, size: this.file.size, mime: this.file.type, createdAt: "2026-01-01T00:00:00Z", hasThumbnail: false };
      control.files.push(file);
      this.responseText = JSON.stringify({ file });
      this.onload?.();
    }
  }
  Object.defineProperty(globalThis, "XMLHttpRequest", { configurable: true, value: FakeXHR });
  const originalTimeout = dom.setTimeout;
  const completions: Array<() => void> = [];
  dom.setTimeout = ((fn: () => void, ms: number) => {
    if (ms === 600) { completions.push(fn); return -(completions.length); }
    return originalTimeout(fn, ms);
  }) as typeof dom.setTimeout;
  const refreshGate = deferred();
  t.after(() => { refreshGate.resolve(); dom.setTimeout = originalTimeout; Object.defineProperty(globalThis, "XMLHttpRequest", { configurable: true, value: originalXHR }); });
  const pasted = new dom.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(pasted, "clipboardData", { value: { files: Array.from({ length: 14 }, (_, index) => new dom.File(["file"], `${index}.txt`, { type: "text/plain" })), items: [] } });
  await act(async () => { dom.dispatchEvent(pasted); });
  assert.equal(dom.document.querySelectorAll('.upload-task').length, 14);
  assert.equal(requests.length, 1);
  assert.equal(dom.document.querySelectorAll('.upload-task.queued').length, 13);
  await act(async () => { requests[0].upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 }); });
  assert.match(dom.document.querySelector('.upload-task.processing')?.textContent ?? "", /服务器处理中/);
  assert.doesNotMatch(dom.document.querySelector('.upload-task.processing')?.textContent ?? "", /100%/);
  assert.equal(dom.document.querySelectorAll('.file-row').length, 0);
  await act(async () => { requests[0].finish(); });
  assert.equal(dom.document.querySelectorAll('.file-row').length, 1);
  assert.equal(requests.length, 2);
  await act(async () => { completions[0](); });
  assert.equal(dom.document.querySelectorAll('.upload-task.done').length, 0);
  assert.equal(dom.document.querySelectorAll('.upload-task').length, 13);
  control.before = async (_method, url) => { if (url === "/api/state") await refreshGate.promise; };
  for (let index = 1; index < 14; index += 1) await act(async () => { requests[index].finish(); });
  assert.equal(dom.document.querySelectorAll('.file-row').length, 14);
  await act(async () => { completions.slice(1).forEach((finish) => finish()); });
  assert.equal(dom.document.querySelectorAll('.upload-task').length, 0);
  refreshGate.resolve();
  await flush();
});

test("saved note images expand inline from the original and unlink without deleting the shared file", async (t) => {
  const image = { id: "image-a", name: "fixture.png", size: 10, mime: "image/png", createdAt: "2026-01-01T00:00:00Z", hasThumbnail: true };
  const { notes, control } = await setup(t, ({ notes, control }) => {
    notes.set("a", { ...notes.get("a")!, attachments: [image.id] });
    control.files = [image];
  });
  await openNote("Test A");
  assert.equal(dom.document.querySelector<HTMLImageElement>('.note-attachment-image')?.getAttribute("src"), `/api/files/${image.id}/preview`);
  assert.doesNotMatch(dom.document.querySelector('.note-attachment-toolbar')?.textContent ?? "", /fixture\.png/);
  assert.equal(dom.document.querySelector('.note-attachment a'), null);
  assert.ok(dom.document.querySelector(`[aria-label="查看并识别 ${image.name}"]`));
  assert.equal(dom.document.querySelector('.image-lightbox'), null);
  control.ocrText = "Manual OCR result";
  await click(`[aria-label="识别 ${image.name} 中的文字"]`);
  assert.equal(notes.get("a")?.content, "Original A\n\nManual OCR result");
  await click(`[aria-label="查看并识别 ${image.name}"]`);
  assert.equal(dom.document.querySelector<HTMLTextAreaElement>('[aria-label="可选择的图片识别文字"]')?.value, "Manual OCR result");
  assert.doesNotMatch(dom.document.querySelector(".image-lightbox")?.textContent ?? "", /fixture\.png/);
  await click('[aria-label="关闭原图预览"]');
  await click('.note-attachment-remove');
  await click('.note-editor-actions .primary');
  assert.deepEqual(notes.get("a")?.attachments, []);
  assert.equal(control.files.length, 1);
});

test("OCR preserves text typed while recognition is pending and blocks note switches", async (t) => {
  const image = { id: "image-slow", name: "slow.png", size: 10, mime: "image/png", createdAt: "2026-01-01T00:00:00Z", hasThumbnail: true };
  const gate = deferred();
  const { notes, control } = await setup(t, ({ notes, control }) => {
    notes.set("a", { ...notes.get("a")!, attachments: [image.id] });
    control.files = [image];
    control.ocrText = "Delayed OCR";
  });
  await openNote("Test A");
  control.before = async (method, url) => { if (method === "POST" && url.endsWith("/ocr")) await gate.promise; };
  await click(`[aria-label="识别 ${image.name} 中的文字"]`);
  assert.equal([...dom.document.querySelectorAll<HTMLButtonElement>(".note-item")].every((item) => item.disabled), true);
  await type("笔记内容", "Typed while OCR runs");
  gate.resolve();
  await flush();
  await flush();
  assert.equal(notes.get("a")?.content, "Typed while OCR runs\n\nDelayed OCR");
});

test("PDF export prints only the current note representation", async (t) => {
  let printCalls = 0;
  const originalPrint = dom.print;
  Object.defineProperty(dom, "print", { configurable: true, value: () => { printCalls += 1; } });
  t.after(() => { Object.defineProperty(dom, "print", { configurable: true, value: originalPrint }); });
  await setup(t);
  await openNote("Test A");
  assert.equal(dom.document.querySelector(".note-print-content")?.textContent, "Original A");
  await click('[aria-label="导出当前笔记为 PDF"]');
  assert.equal(printCalls, 1);
});

test("pasting a screenshot uploads once and immediately persists its note attachment", async (t) => {
  const image = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "pasted.png", size: 10, mime: "image/png", createdAt: "2026-01-01T00:00:00Z", hasThumbnail: true };
  const { notes, control, requests } = await setup(t, ({ control }) => { control.ocrText = "识别出来的图片文字"; });
  const originalXHR = globalThis.XMLHttpRequest;
  class FakeXHR {
    upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
    status = 201;
    responseText = JSON.stringify({ file: image });
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    open() {}
    setRequestHeader() {}
    abort() { this.onabort?.(); }
    send() { control.files = [image]; queueMicrotask(() => this.onload?.()); }
  }
  Object.defineProperty(globalThis, "XMLHttpRequest", { configurable: true, value: FakeXHR });
  t.after(() => { Object.defineProperty(globalThis, "XMLHttpRequest", { configurable: true, value: originalXHR }); });
  await openNote("Test A");
  const pasted = new dom.File([new Uint8Array([137, 80, 78, 71])], "pasted.png", { type: "image/png" });
  const event = new dom.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { items: [{ kind: "file", type: "image/png", getAsFile: () => pasted }] } });
  await act(async () => { field("笔记内容").dispatchEvent(event as unknown as Event); });
  await flush();
  await flush();
  assert.equal(dom.document.querySelector<HTMLImageElement>('.note-attachment-image')?.getAttribute("src"), `/api/files/${image.id}/preview`);
  assert.deepEqual(notes.get("a")?.attachments, [image.id]);
  assert.equal(notes.get("a")?.content, "Original A\n\n识别出来的图片文字");
  assert.equal(requests.filter((request) => request.url === `/api/files/${image.id}/ocr`).length, 1);
  assert.match(dom.document.body.textContent ?? "", /已自动识别 1 张图片的文字/);
  assert.match(footer()!, /已保存/);
  assert.equal(control.files.length, 1);
});

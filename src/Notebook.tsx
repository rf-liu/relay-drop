import { ArrowLeft, BookOpen, Copy, FileDown, ImagePlus, LoaderCircle, PanelLeft, Plus, RefreshCw, ScanText, Trash2, X } from "lucide-react";
import { type ChangeEvent, type ClipboardEvent, type Ref, useCallback, useEffect, useEffectEvent, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { ImageLightbox } from "./ImageLightbox";
import { canApplyNoteRead, emptyNoteDraft, sameNoteDraft, settleNoteWrite, type Note, type NoteDraft, type NoteSummary } from "./note-editor";

export interface NotebookHandle { saveBeforeLeave(): Promise<boolean>; saveNow(): Promise<boolean> }
export interface NotebookImage { id: string; name: string; mime: string; hasThumbnail: boolean }
interface Props {
  ref?: Ref<NotebookHandle>;
  open: boolean;
  revision: number;
  files: NotebookImage[];
  onBack(): void;
  onStorageChange(): void;
  onUploadImages(files: globalThis.File[]): Promise<NotebookImage[]>;
  notify(message: string, kind?: "success" | "error"): void;
}
const emptyDraft: NoteDraft = { title: "", content: "", attachments: [] };
const NOTE_IMAGE_TYPES = new Set(["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"]);
const MAX_NOTE_CHARACTERS = 1_000_000;
const AUTOSAVE_DELAY = 2_000;
interface SaveFailure { message: string; retryable: boolean; attempt: number; retryAt: number }

async function noteApi<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  try { return await api<T>(url, { ...init, signal: controller.signal }); }
  catch (cause) {
    if (controller.signal.aborted) throw new Error("连接超时，当前文字仍保留在编辑区，请重试。");
    throw cause;
  } finally { window.clearTimeout(timeout); }
}

async function imageTextApi(id: string): Promise<{ text: string }> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 35_000);
  try { return await api<{ text: string }>(`/api/files/${id}/ocr`, { method: "POST", signal: controller.signal }); }
  catch (cause) {
    if (controller.signal.aborted) throw new Error("文字识别超时，请稍后重试。");
    throw cause;
  } finally { window.clearTimeout(timeout); }
}

async function waitForPrintableImages(images: HTMLImageElement[]): Promise<void> {
  images.forEach((image) => { image.loading = "eager"; });
  const loaded = Promise.allSettled(images.map((image) => image.complete
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
      image.addEventListener("load", () => resolve(), { once: true });
      image.addEventListener("error", () => resolve(), { once: true });
    })));
  await Promise.race([loaded, new Promise<void>((resolve) => window.setTimeout(resolve, 12_000))]);
}

export function Notebook({ ref, open, revision, files, onBack, onStorageChange, onUploadImages, notify }: Props) {
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [selected, setSelected] = useState<Note | null>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isNew, setIsNew] = useState(false);
  const [uploadingImages, setUploadingImages] = useState(false);
  const [recognizingIds, setRecognizingIds] = useState<Set<string>>(() => new Set());
  const [printing, setPrinting] = useState(false);
  const [previewImage, setPreviewImage] = useState<NotebookImage | null>(null);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saveFailure, setSaveFailure] = useState<SaveFailure | null>(null);
  const [isComposing, setIsComposing] = useState(false);
  const [showList, setShowList] = useState(true);
  const selectedRef = useRef<Note | null>(null);
  const draftRef = useRef(emptyDraft);
  const actionPending = useRef(false);
  const deleting = useRef(false);
  const savePending = useRef<Promise<boolean> | null>(null);
  const isNewRef = useRef(false);
  const createAttempt = useRef<NoteDraft | null>(null);
  const editRevision = useRef(0);
  const composing = useRef(false);
  const uploadingImagesRef = useRef(false);
  const recognizingIdsRef = useRef(new Set<string>());
  const ocrTextCache = useRef(new Map<string, string>());
  const imageInput = useRef<HTMLInputElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const contentInput = useRef<HTMLTextAreaElement>(null);
  const documentRef = useRef<HTMLDivElement>(null);
  const listRequest = useRef(0);
  const busy = working || uploadingImages || printing;
  const recognizingImages = recognizingIds.size > 0;
  const navigationBusy = busy || recognizingImages;
  const hasChanges = () => selectedRef.current !== null && (isNewRef.current
    ? !emptyNoteDraft(draftRef.current) || createAttempt.current !== null
    : !sameNoteDraft(draftRef.current, selectedRef.current));
  const dirty = selected !== null && (isNew ? !emptyNoteDraft(draft) || createAttempt.current !== null : !sameNoteDraft(draft, selected));

  const useNote = useCallback((note: Note | null, fresh = false) => {
    editRevision.current += 1;
    selectedRef.current = note;
    draftRef.current = note ? { title: note.title, content: note.content, attachments: [...note.attachments] } : emptyDraft;
    isNewRef.current = fresh;
    createAttempt.current = null;
    setSelected(note);
    setDraft(draftRef.current);
    setIsNew(fresh);
    setConfirmDelete(false);
    setSaveFailure(null);
    setShowList(note === null);
    setPreviewImage(null);
    setError("");
  }, []);

  useLayoutEffect(() => {
    const input = contentInput.current;
    if (!open || !input) return;
    const resize = () => {
      const documentTop = documentRef.current?.scrollTop ?? 0;
      const pageTop = window.scrollY;
      input.style.height = "0px";
      input.style.height = `${input.scrollHeight}px`;
      // Measuring a shorter textarea can clamp its ancestor's scroll position.
      // Restore it in the same layout pass so typing at the end stays in view.
      if (documentRef.current) documentRef.current.scrollTop = documentTop;
      if (window.scrollY !== pageTop) window.scrollTo(0, pageTop);
    };
    resize();
    // A mobile list/editor switch or a viewport resize changes line wrapping.
    let width = input.clientWidth;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      if (input.clientWidth !== width) { width = input.clientWidth; resize(); }
    });
    observer?.observe(input);
    return () => observer?.disconnect();
  }, [open, draft.content, selected?.id, showList]);

  useEffect(() => {
    documentRef.current?.scrollTo?.(0, 0);
    if (isNewRef.current) titleInput.current?.focus();
  }, [selected?.id]);

  const loadNotes = useCallback(async (refreshEditor = true) => {
    const request = ++listRequest.current;
    const note = selectedRef.current;
    const requestedRevision = editRevision.current;
    const refreshCurrent = refreshEditor && note && !isNewRef.current && !savePending.current
      && sameNoteDraft(draftRef.current, note) && !composing.current;
    setLoading(true);
    try {
      const result = await noteApi<{ notes: NoteSummary[] }>("/api/notes", { cache: "no-store" });
      if (request !== listRequest.current) return;
      setNotes(result.notes);
      if (!refreshCurrent) {
        if (!savePending.current && !isNewRef.current && sameNoteDraft(draftRef.current, selectedRef.current ?? emptyDraft)) setError("");
        return;
      }
      const current = await noteApi<{ note: Note }>(`/api/notes/${note.id}`, { cache: "no-store" });
      if (request === listRequest.current && canApplyNoteRead(note.id, selectedRef.current?.id, requestedRevision, editRevision.current, !sameNoteDraft(draftRef.current, selectedRef.current ?? emptyDraft), composing.current)) {
        useNote(current.note);
      }
    } catch (cause) {
      if (request !== listRequest.current) return;
      if (cause instanceof ApiError && cause.status === 404 && refreshCurrent
        && canApplyNoteRead(note.id, selectedRef.current?.id, requestedRevision, editRevision.current, !sameNoteDraft(draftRef.current, selectedRef.current ?? emptyDraft), composing.current)) {
        useNote(null);
      } else setError((cause as Error).message);
    }
    finally { if (request === listRequest.current) setLoading(false); }
  }, [useNote]);

  useEffect(() => { if (open) void loadNotes(); }, [open, revision, loadNotes]);

  const save = (silent = false): Promise<boolean> => {
    if (savePending.current) return savePending.current;
    if (composing.current || deleting.current) return Promise.resolve(false);
    const note = selectedRef.current;
    if (!note || !hasChanges()) {
      if (note && !silent) notify(isNewRef.current ? "空白笔记尚未保存" : "笔记已保存");
      return Promise.resolve(true);
    }
    editRevision.current += 1;
    setSaving(true);
    const acceptSave = (saved: Note, submitted: NoteDraft) => {
      selectedRef.current = saved;
      setSelected(saved);
      isNewRef.current = false;
      setIsNew(false);
      if (!composing.current) {
        draftRef.current = settleNoteWrite(draftRef.current, submitted, saved);
        setDraft(draftRef.current);
      }
    };
    const operation = (async () => {
      try {
        if (isNewRef.current) {
          // Reuse the original payload and ID after an uncertain create result.
          createAttempt.current ??= { ...draftRef.current, attachments: [...draftRef.current.attachments] };
          const submitted = createAttempt.current;
          const result = await noteApi<{ note: Note }>("/api/notes", { method: "POST", body: JSON.stringify({ id: note.id, ...submitted }) });
          acceptSave(result.note, submitted);
          createAttempt.current = null;
        }
        if (hasChanges() && !composing.current) {
          const submitted = { ...draftRef.current, attachments: [...draftRef.current.attachments] };
          const result = await noteApi<{ note: Note }>(`/api/notes/${note.id}`, { method: "PUT", body: JSON.stringify(submitted) });
          acceptSave(result.note, submitted);
        }
        setError("");
        // Update the sidebar in place: autosaving must not spin its refresh
        // button, reorder rows under the pointer, or trigger an editor read.
        const savedNote = selectedRef.current!;
        const summary: NoteSummary = {
          id: savedNote.id, title: savedNote.title, createdAt: savedNote.createdAt, updatedAt: savedNote.updatedAt,
          preview: Array.from(savedNote.content.replace(/\s+/g, " ")).slice(0, 100).join(""), characters: savedNote.content.length, attachmentCount: savedNote.attachments.length,
        };
        setNotes((current) => current.some((item) => item.id === summary.id)
          ? current.map((item) => item.id === summary.id ? summary : item)
          : [summary, ...current]);
        setSaveFailure(null);
        onStorageChange();
        const saved = !hasChanges() && !composing.current;
        if (!silent) notify(saved ? "笔记已保存" : "已保存，新增文字仍保留在编辑区");
        return saved;
      } catch (cause) {
        const retryable = !(cause instanceof ApiError) || [408, 429, 500, 502, 503, 504].includes(cause.status);
        setSaveFailure((previous) => {
          const attempt = (previous?.attempt ?? 0) + 1;
          return { message: (cause as Error).message, retryable, attempt, retryAt: Date.now() + Math.min(30_000, 5_000 * 2 ** Math.min(attempt, 3)) };
        });
        return false;
      }
      finally { savePending.current = null; setSaving(false); }
    })();
    savePending.current = operation;
    return operation;
  };

  const autosave = useEffectEvent(() => {
    if (open && !actionPending.current && !uploadingImagesRef.current && !recognizingIdsRef.current.size && !printing && !confirmDelete) void save(true);
  });

  useEffect(() => {
    if (!open || !dirty || saving || busy || recognizingImages || isComposing || confirmDelete || (saveFailure && !saveFailure.retryable)) return;
    const wait = saveFailure ? Math.max(AUTOSAVE_DELAY, saveFailure.retryAt - Date.now()) : AUTOSAVE_DELAY;
    const timer = window.setTimeout(() => autosave(), wait);
    return () => window.clearTimeout(timer);
  }, [open, draft, dirty, saving, busy, recognizingImages, isComposing, confirmDelete, saveFailure]);

  const resumeSave = useEffectEvent(() => { if (!saveFailure || saveFailure.retryable) autosave(); });
  useEffect(() => {
    if (!open) return;
    const onOnline = () => resumeSave();
    const onVisibility = () => { if (document.visibilityState === "hidden") resumeSave(); };
    const onUnload = (event: BeforeUnloadEvent) => {
      if (hasChanges() || savePending.current || uploadingImagesRef.current || recognizingIdsRef.current.size) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("beforeunload", onUnload);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("beforeunload", onUnload);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [open]);

  useImperativeHandle(ref, () => ({
    async saveNow() {
      if (savePending.current) await savePending.current;
      return save();
    },
    async saveBeforeLeave() {
      if (uploadingImagesRef.current || recognizingIdsRef.current.size > 0) return false;
      if (!(await save(true))) return false;
      // Ignore pending reads even if the user reopens the notebook immediately.
      editRevision.current += 1;
      if (isNewRef.current && !createAttempt.current && emptyNoteDraft(draftRef.current)) useNote(null);
      return true;
    },
  }));

  const changeDraft = <K extends keyof NoteDraft,>(field: K, value: NoteDraft[K]) => {
    editRevision.current += 1;
    draftRef.current = { ...draftRef.current, [field]: value };
    setDraft(draftRef.current);
    const changed = hasChanges();
    setSaveFailure((previous) => previous && (!previous.retryable || !changed) ? null : previous);
  };

  const startComposition = () => { composing.current = true; setIsComposing(true); editRevision.current += 1; };
  const endComposition = () => { composing.current = false; setIsComposing(false); };

  const recognizeImage = async (file: NotebookImage, announce = true): Promise<"saved" | "draft" | "empty" | "failed"> => {
    if (recognizingIdsRef.current.has(file.id)) return "failed";
    recognizingIdsRef.current.add(file.id);
    setRecognizingIds(new Set(recognizingIdsRef.current));
    try {
      const result = await imageTextApi(file.id);
      const recognized = result.text.trim();
      ocrTextCache.current.set(file.id, recognized);
      if (!recognized) {
        if (announce) notify("没有识别到清晰文字");
        return "empty";
      }
      const current = draftRef.current.content;
      const separator = !current ? "" : current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
      const available = MAX_NOTE_CHARACTERS - current.length - separator.length;
      if (available <= 0) {
        if (announce) notify("笔记正文已达到长度上限，无法加入识别文字", "error");
        return "failed";
      }
      changeDraft("content", `${current}${separator}${recognized.slice(0, available)}`);
      const persisted = await save(true);
      if (announce) notify(persisted ? "识别文字已加入并保存" : "识别文字已加入草稿，请稍后保存", persisted ? "success" : "error");
      return persisted ? "saved" : "draft";
    } catch (cause) {
      if (announce) notify((cause as Error).message || "文字识别失败，请稍后重试", "error");
      return "failed";
    } finally {
      recognizingIdsRef.current.delete(file.id);
      setRecognizingIds(new Set(recognizingIdsRef.current));
    }
  };

  const exportPdf = async () => {
    if (!selectedRef.current || printing) return;
    if (!(await save(true))) return notify("请先保存当前笔记再导出", "error");
    setPrinting(true);
    try {
      const images = [...document.querySelectorAll<HTMLImageElement>(".notebook:not([hidden]) .note-attachment-image")];
      await waitForPrintableImages(images);
      const previousTitle = document.title;
      document.title = (draftRef.current.title.trim() || "Relay 笔记").replace(/[\\/:*?"<>|]/g, "-");
      notify("请在打印窗口中选择“存储为 PDF”");
      window.print();
      window.setTimeout(() => { document.title = previousTitle; }, 0);
    } finally { setPrinting(false); }
  };

  const importImages = async (incoming: FileList | globalThis.File[]) => {
    const images = Array.from(incoming).filter((file) => NOTE_IMAGE_TYPES.has(file.type));
    if (!images.length) return notify("请选择 PNG、JPEG、GIF、WebP 或 AVIF 图片", "error");
    if (uploadingImagesRef.current) return notify("上一批图片仍在上传", "error");
    uploadingImagesRef.current = true;
    setUploadingImages(true);
    try {
      const uploaded = (await onUploadImages(images)).filter((file) => file.hasThumbnail);
      if (!uploaded.length) return notify("图片未能生成安全缩略图，已保留在文件中转区", "error");
      const uploadedIds = uploaded.map((file) => file.id);
      changeDraft("attachments", [...new Set([...draftRef.current.attachments, ...uploadedIds])]);
      await save(true);
      const persisted = uploadedIds.every((id) => selectedRef.current?.attachments.includes(id));
      const recognition: Array<"saved" | "draft" | "empty" | "failed"> = [];
      for (const file of uploaded) recognition.push(await recognizeImage(file, false));
      const recognized = recognition.filter((result) => result === "saved" || result === "draft").length;
      const failed = recognition.some((result) => result === "failed");
      if (recognized) notify(`图片已保存，已自动识别 ${recognized} 张图片的文字`, recognition.includes("draft") ? "error" : "success");
      else if (failed) notify("图片已保存，文字识别暂时失败，可稍后重试", "error");
      else notify(persisted ? "图片已添加，未识别到清晰文字" : "图片已上传，但笔记保存失败，请重试", persisted ? "success" : "error");
    } catch (cause) {
      notify((cause as Error).message || "图片上传失败", "error");
    } finally {
      uploadingImagesRef.current = false;
      setUploadingImages(false);
    }
  };

  const onImageInput = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) void importImages(event.target.files);
    event.target.value = "";
  };

  const onNotePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && NOTE_IMAGE_TYPES.has(item.type))
      .map((item) => item.getAsFile())
      .filter((file): file is globalThis.File => file !== null);
    if (!images.length) return;
    event.preventDefault();
    void importImages(images);
  };

  const openNote = async (id: string) => {
    if (actionPending.current || recognizingIdsRef.current.size > 0 || composing.current) return;
    actionPending.current = true;
    setWorking(true);
    try {
      if (!(await save(true))) return;
      const requestedId = selectedRef.current?.id;
      const requestedRevision = editRevision.current;
      const result = await noteApi<{ note: Note }>(`/api/notes/${id}`, { cache: "no-store" });
      if (canApplyNoteRead(requestedId, selectedRef.current?.id, requestedRevision, editRevision.current, hasChanges(), composing.current)) useNote(result.note);
    }
    catch (cause) { setError((cause as Error).message); }
    finally { actionPending.current = false; setWorking(false); }
  };

  const newNote = async () => {
    if (actionPending.current || recognizingIdsRef.current.size > 0 || composing.current) return;
    actionPending.current = true;
    setWorking(true);
    try {
      if (!(await save(true))) return;
      useNote({ id: crypto.randomUUID(), ...emptyDraft, attachments: [], createdAt: "", updatedAt: "" }, true);
    } finally { actionPending.current = false; setWorking(false); }
  };

  const removeNote = async () => {
    const note = selectedRef.current;
    if (!note || actionPending.current || savePending.current || recognizingIdsRef.current.size > 0 || composing.current) return;
    actionPending.current = true;
    deleting.current = true;
    setWorking(true);
    const requestedRevision = ++editRevision.current;
    try {
      if (!isNewRef.current || createAttempt.current) await noteApi<void>(`/api/notes/${note.id}`, { method: "DELETE" }).catch((cause: unknown) => {
        if (!(cause instanceof ApiError && cause.status === 404)) throw cause;
      });
      if (requestedRevision === editRevision.current) useNote(null);
      else useNote({ id: crypto.randomUUID(), ...draftRef.current, attachments: [...draftRef.current.attachments], createdAt: "", updatedAt: "" }, true);
      void loadNotes(false);
      onStorageChange();
      notify("笔记已删除");
    } catch (cause) { setError((cause as Error).message); }
    finally { deleting.current = false; actionPending.current = false; setWorking(false); }
  };

  const saveStatus = saveFailure ? "error" : saving ? "saving" : dirty ? "pending" : "saved";
  const saveDescription = saveFailure ? "保存失败，文字仍在编辑区" : saving ? "正在保存…" : uploadingImages ? "正在添加图片…" : recognizingImages ? "正在识别文字…" : dirty ? "未保存 · 等待自动保存" : isNew ? "新笔记" : "已保存";

  return (
    <section className={`notebook ${showList ? "is-list-view" : "is-editor-view"}`} hidden={!open} aria-label="记事本">
      <div className="notebook-heading">
        <button className="button ghost" onClick={onBack} disabled={navigationBusy}><ArrowLeft size={16} /> 返回中转</button>
        <button className="button primary" onClick={() => void newNote()} disabled={navigationBusy}><Plus size={16} /> 新建笔记</button>
      </div>
      {(saveFailure || error) && <div className="notebook-error" role="alert"><span>{saveFailure?.message || error}</span><button className="button ghost" onClick={() => { if (saveFailure) void save(true); else void loadNotes(); }} disabled={saving}>{saveFailure ? "重试保存" : "刷新列表"}</button></div>}
      <div className="card notebook-layout">
        <aside className="notebook-list" aria-label="笔记列表">
          <div className="notebook-list-heading"><h2>记事本 <span>{notes.length}</span></h2><button className="icon-button" aria-label="刷新笔记列表" onClick={() => void loadNotes()} disabled={loading}><RefreshCw size={15} className={loading ? "spin" : undefined} /></button></div>
          <div className="notebook-list-scroll">
          {isNew && selected && <button className="note-item is-selected" onClick={() => setShowList(false)} aria-pressed="true"><strong>{draft.title || "新笔记"}</strong><span>{draft.content || "写下第一句话…"}</span><small>草稿</small></button>}
          {notes.map((note) => <button key={note.id} className={`note-item ${selected?.id === note.id ? "is-selected" : ""}`} onClick={() => { if (selectedRef.current?.id === note.id) setShowList(false); else void openNote(note.id); }} disabled={navigationBusy} aria-pressed={selected?.id === note.id}>
            <strong>{note.title}</strong><span>{note.preview || (note.attachmentCount ? `${note.attachmentCount} 张图片` : "空白笔记")}</span><small>{new Date(note.updatedAt).toLocaleDateString("zh-CN")} · {note.characters.toLocaleString()} 字符{note.attachmentCount ? ` · ${note.attachmentCount} 图` : ""}</small>
          </button>)}
          {!notes.length && !isNew && <p className="notebook-list-empty">{loading ? "正在读取…" : "还没有笔记"}</p>}
          </div>
        </aside>
        <div className="notebook-editor">
          {selected ? <>
            <div className="note-editor-toolbar">
              <button className="button ghost note-show-list" onClick={() => setShowList(true)} aria-label="返回笔记列表"><PanelLeft size={16} /><span>笔记列表</span></button>
              <div className="note-tools">
                <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif" multiple hidden onChange={onImageInput} />
                <button className="icon-button" aria-label="导入图片" title="添加图片" onClick={() => imageInput.current?.click()} disabled={navigationBusy}>{uploadingImages ? <LoaderCircle className="spin" size={16} /> : <ImagePlus size={16} />}</button>
                <button className="icon-button" aria-label="复制笔记内容" title="复制文字" onClick={() => { void navigator.clipboard.writeText(draft.content).then(() => notify("已复制笔记"), () => notify("请手动选择文字复制", "error")); }} disabled={!draft.content}><Copy size={16} /></button>
                <button className="icon-button" onClick={() => void exportPdf()} disabled={navigationBusy || emptyNoteDraft(draft)} aria-label="导出当前笔记为 PDF" title="导出 PDF">{printing ? <LoaderCircle className="spin" size={16} /> : <FileDown size={16} />}</button>
                <span className="note-tools-divider" />
                <button className="icon-button note-delete-button" aria-label="删除笔记" title="删除笔记" onClick={() => setConfirmDelete(true)} disabled={navigationBusy}><Trash2 size={16} /></button>
              </div>
            </div>
            <div className="note-document" ref={documentRef}>
            <input ref={titleInput} className="note-title" aria-label="笔记标题" placeholder="无标题笔记" maxLength={120} value={draft.title} onCompositionStart={startComposition} onCompositionEnd={endComposition} onChange={(event) => changeDraft("title", event.target.value)} />
            <textarea ref={contentInput} className="note-content" aria-label="笔记内容" placeholder="写点什么，或粘贴图片…" value={draft.content} spellCheck={false} onPaste={onNotePaste} onCompositionStart={startComposition} onCompositionEnd={endComposition} onChange={(event) => changeDraft("content", event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void save(); } }} />
            {draft.attachments.length > 0 && <div className="note-attachments" aria-label="笔记图片">
              {draft.attachments.map((id) => {
                const file = files.find((candidate) => candidate.id === id);
                const recognizing = recognizingIds.has(id);
                return file ? <div className="note-attachment" key={id}>
                  <button className="note-attachment-open" type="button" onClick={() => setPreviewImage(file)} disabled={navigationBusy} aria-label={`查看并识别 ${file.name}`} title="打开原图并选择文字">
                    <img className="note-attachment-image" src={`/api/files/${file.id}/preview`} alt={file.name} loading="lazy" decoding="async" />
                  </button>
                  <div className="note-attachment-toolbar">
                    <div>
                      <button className="note-attachment-action" onClick={() => void recognizeImage(file)} disabled={navigationBusy} aria-label={`识别 ${file.name} 中的文字`} title="识别图片文字并追加到笔记"><span>{recognizing ? "识别中" : "OCR"}</span>{recognizing ? <LoaderCircle className="spin" size={13} /> : <ScanText size={13} />}</button>
                      <button className="note-attachment-remove" onClick={() => changeDraft("attachments", draftRef.current.attachments.filter((attachment) => attachment !== id))} disabled={navigationBusy} aria-label={`从笔记移除 ${file.name}`} title="从笔记移除，文件仍保留在中转区"><X size={13} /></button>
                    </div>
                  </div>
                </div> : <div className="note-attachment is-missing" key={id}><span>图片已从文件区删除</span><button className="note-attachment-remove" onClick={() => changeDraft("attachments", draftRef.current.attachments.filter((attachment) => attachment !== id))} disabled={navigationBusy} aria-label="移除已删除的图片"><X size={13} /></button></div>;
              })}
            </div>}
            <div className="note-print-content" aria-hidden="true">{draft.content}</div>
            </div>
            {confirmDelete && <div className="note-delete-confirm" role="alert"><span>删除这条笔记？</span><div><button className="button ghost" onClick={() => setConfirmDelete(false)}>取消</button><button className="button danger-ghost" onClick={() => void removeNote()} disabled={navigationBusy || saving}>确认删除</button></div></div>}
            <div className="note-editor-footer">
              <span className="note-save-status" role="status" title={saveDescription}><i className={`note-save-dot is-${saveStatus}`} />{saveDescription}</span>
              <div className="note-editor-actions"><span className="note-word-count">{draft.content.length.toLocaleString()} 字符</span><button className="button primary note-save-button" onClick={() => void save()} disabled={busy} aria-label="保存笔记" title="保存笔记（⌘ / Ctrl + Enter）">保存</button></div>
            </div>
          </> : <div className="empty-state notebook-empty"><div className="notebook-empty-icon"><BookOpen size={26} /></div><strong>从一条笔记开始</strong><span>选择左侧笔记，或新建一条</span><button className="button secondary" onClick={() => void newNote()}><Plus size={15} /> 新建笔记</button></div>}
        </div>
      </div>
      {previewImage && <ImageLightbox key={previewImage.id} image={previewImage} initialOcrText={ocrTextCache.current.get(previewImage.id)} onRecognized={(text) => ocrTextCache.current.set(previewImage.id, text)} onClose={() => setPreviewImage(null)} />}
    </section>
  );
}

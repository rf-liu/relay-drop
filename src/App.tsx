import {
  Archive,
  BookOpen,
  BookmarkPlus,
  Check,
  Clipboard,
  CloudUpload,
  Copy,
  Download,
  File,
  FileArchive,
  FileText,
  Film,
  Image,
  LoaderCircle,
  Moon,
  Music,
  Pencil,
  RefreshCw,
  RotateCcw,
  Search,
  Sun,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { clipboardAutosaveDelay, clipboardSyncAction, settleClipboardRead, settleClipboardWrite } from "./clipboard";
import { api, ApiError } from "./api";
import { ImageLightbox } from "./ImageLightbox";
import { Notebook, type NotebookHandle } from "./Notebook";

interface ClipboardState {
  content: string;
  updatedAt: string | null;
}

export interface RelayFile {
  id: string;
  name: string;
  size: number;
  mime: string;
  createdAt: string;
  hasThumbnail: boolean;
}

interface RelayState {
  clipboard: ClipboardState;
  files: RelayFile[];
  limits: { maxUploadBytes: number };
  storage: { usedBytes: number; maxBytes: number };
}

interface UploadTask {
  id: string;
  name: string;
  progress: number;
  status: "queued" | "uploading" | "processing" | "done" | "error";
  error?: string;
  // 保留原文件引用，失败后可以在同一行重试，而不是新增一行。
  file: globalThis.File;
  // 只有网络类失败值得重试；配额、体积这类结论重试也不会变。
  retryable?: boolean;
  // 瞬时上行速度，字节/秒。慢的时候用户至少知道它还在动。
  speed?: number;
}

type UploadOutcome = { ok: true; file: RelayFile } | { ok: false; message: string; retryable: boolean };
interface StateLoadOptions { force?: boolean; refreshClipboard?: boolean }

interface ToastState {
  id: number;
  message: string;
  kind: "success" | "error";
}

const EMPTY_STATE: RelayState = {
  clipboard: { content: "", updatedAt: null },
  files: [],
  limits: { maxUploadBytes: 2 * 1024 * 1024 * 1024 },
  storage: { usedBytes: 0, maxBytes: 20 * 1024 * 1024 * 1024 },
};

// 并发上传会共用同一条 HTTP/2 连接：链路一断，所有文件一起失败。
// 但网好的时候串行又太亏，所以并发数不写死，按实测的「上行速度」自己调。
const UPLOAD_CONCURRENCY_MAX = 4;
// 超过这个时间一个字节都没有前进，就认为链路已经死了，主动中断而不是干等。
// 用「停滞时长」而不是「总时长」，大文件慢慢传也不会被误杀。
const UPLOAD_STALL_MS = 90_000;
// 网络类失败的尝试总次数（含第一次）。
const UPLOAD_MAX_ATTEMPTS = 3;
// 进度采样间隔，用来算瞬时速度。
const SPEED_SAMPLE_MS = 500;
// 测速结果的保质期。网络状况随时会变，超过这个时间就当没测过，重新用一个文件探路。
const SPEED_FRESH_MS = 60_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => { window.setTimeout(resolve, ms); });

interface NetworkInformation { saveData?: boolean }

// 按实测上行速度决定并发数。
// 注意只用「上传」测出来的速度：navigator.connection 的 effectiveType 反映的是下行，
// 而「下行正常、上行垮掉」是很常见的一种情况，用它判断会得出完全相反的结论。
function concurrencyForSpeed(bytesPerSecond: number | null): number {
  if (bytesPerSecond == null) return 1;                       // 还没测过：先用一个文件探路
  if (bytesPerSecond >= 4 * 1024 * 1024) return UPLOAD_CONCURRENCY_MAX;
  if (bytesPerSecond >= 1024 * 1024) return 3;
  if (bytesPerSecond >= 384 * 1024) return 2;
  return 1;                                                    // 弱网：串行，保住已经传完的
}

function prefersReducedData(): boolean {
  return (navigator as Navigator & { connection?: NetworkInformation }).connection?.saveData === true;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function pastedImageName(file: globalThis.File, index: number): string {
  const extensionByType: Record<string, string> = {
    "image/avif": "avif",
    "image/gif": "gif",
    "image/heic": "heic",
    "image/heif": "heif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/svg+xml": "svg",
    "image/webp": "webp",
  };
  const existingExtension = file.name.match(/\.([a-z0-9]{2,8})$/i)?.[1]?.toLowerCase();
  const extension = existingExtension || extensionByType[file.type] || "png";
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  return `剪贴板图片-${stamp}${index ? `-${index + 1}` : ""}.${extension}`;
}

function filesFromClipboard(data: DataTransfer | null): globalThis.File[] {
  if (!data) return [];
  const directFiles = Array.from(data.files ?? []);
  if (directFiles.length) return directFiles;
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is globalThis.File => file !== null);
}

function preparePastedFiles(files: globalThis.File[]): globalThis.File[] {
  let imageIndex = 0;
  return files.map((file) => {
    if (!file.type.startsWith("image/")) return file;
    const prepared = new globalThis.File([file], pastedImageName(file, imageIndex), {
      type: file.type || "image/png",
      lastModified: Date.now(),
    });
    imageIndex += 1;
    return prepared;
  });
}

// 重命名时默认只选中扩展名之前的部分，和 Finder / 资源管理器一致。
// 想改扩展名仍然可以：⌘A 全选，或者把光标移到后面。
// 约定：
//   photo.png      -> 选中 "photo"
//   archive.tar.gz -> 选中 "archive.tar"（按最后一个点切）
//   .gitignore     -> 全选（点在开头，前面没有可选的名字）
//   README         -> 全选（没有扩展名）
function baseNameEnd(value: string): number {
  const lastDot = value.lastIndexOf(".");
  return lastDot > 0 ? lastDot : value.length;
}

function relativeTime(value: string | null): string {
  if (!value) return "还没有内容";
  const delta = new Date(value).getTime() - Date.now();
  const formatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
  const minutes = Math.round(delta / 60_000);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(delta / 3_600_000);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(delta / 86_400_000), "day");
}

function iconFor(file: RelayFile): ReactNode {
  const props = { size: 20, strokeWidth: 1.8, "aria-hidden": true };
  if (file.mime.startsWith("image/")) return <Image {...props} />;
  if (file.mime.startsWith("video/")) return <Film {...props} />;
  if (file.mime.startsWith("audio/")) return <Music {...props} />;
  if (/\.(zip|rar|7z|tar|gz|bz2)$/i.test(file.name)) return <FileArchive {...props} />;
  if (file.mime.startsWith("text/") || /\.(md|txt|json|csv|log|yml|yaml)$/i.test(file.name)) {
    return <FileText {...props} />;
  }
  return <File {...props} />;
}

function FileVisual({ file, onPreview }: { file: RelayFile; onPreview(file: RelayFile): void }) {
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  if (file.hasThumbnail && !thumbnailFailed) {
    return (
      <button className="file-icon file-thumbnail file-thumbnail-button" type="button" onClick={() => onPreview(file)} title={`放大查看 ${file.name}`} aria-label={`放大查看 ${file.name}`}>
        <img
          src={`/api/files/${file.id}/thumbnail`}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setThumbnailFailed(true)}
        />
      </button>
    );
  }
  return <div className="file-icon">{iconFor(file)}</div>;
}

export default function App() {
  const [state, setState] = useState<RelayState>(EMPTY_STATE);
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [connectionStatus, setConnectionStatus] = useState<"connecting" | "online" | "offline">("connecting");
  const [lastConnectedAt, setLastConnectedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [composing, setComposing] = useState(false);
  const [clipboardError, setClipboardError] = useState("");
  const [clipboardRetryable, setClipboardRetryable] = useState(true);
  const [notebookOpen, setNotebookOpen] = useState(() => window.location.hash === "#notebook");
  const notebookRef = useRef<NotebookHandle>(null);
  const notebookOpenRef = useRef(notebookOpen);
  const [notesRevision, setNotesRevision] = useState(0);
  const [addingNote, setAddingNote] = useState(false);
  const [refreshingClipboard, setRefreshingClipboard] = useState(false);
  const [refreshingFiles, setRefreshingFiles] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState<UploadTask[]>([]);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"newest" | "name" | "size">("newest");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [previewImage, setPreviewImage] = useState<RelayFile | null>(null);
  const [batchDownloading, setBatchDownloading] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem("relay-theme");
    return saved ? saved === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  });
  const [toast, setToast] = useState<ToastState | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const selectAllInput = useRef<HTMLInputElement>(null);
  const selectionAnchor = useRef<string | null>(null);
  const completedUploadTimers = useRef(new Set<number>());
  const dirtyRef = useRef(false);
  const draftRef = useRef("");
  const clipboardEditRevision = useRef(0);
  const manualSyncQueued = useRef(false);
  const composingRef = useRef(false);
  const addingNoteRef = useRef(false);
  const noteSnapshot = useRef<{ id: string; content: string } | null>(null);
  const clipboardWritePending = useRef(false);
  const clipboardFocused = useRef(false);
  const clipboardRefreshPending = useRef(false);
  const filesRefreshPending = useRef(false);
  const stateRequestId = useRef(0);
  const stateRequestAbort = useRef<AbortController | null>(null);
  const toastId = useRef(0);
  // 实测上行速度（字节/秒）的滑动平均，跨批次沿用，但有保质期。
  const linkSpeed = useRef<number | null>(null);
  const linkSpeedAt = useRef(0);
  // 正在飞的请求，用来支持取消。
  const activeUploads = useRef(new Map<string, XMLHttpRequest>());
  const cancelled = useRef(new Set<string>());
  // 所有上传（新批次和手动重试）共用一条队列，避免多批并发一起压垮弱网链路。
  const uploadChain = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => () => {
    for (const timer of completedUploadTimers.current) window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    let navigation = 0;
    const navigate = async () => {
      const request = ++navigation;
      const nextOpen = window.location.hash === "#notebook";
      if (!nextOpen && notebookOpenRef.current) {
        const saved = await notebookRef.current?.saveBeforeLeave();
        if (request !== navigation) return;
        if (saved === false) {
          window.history.replaceState(null, "", "#notebook");
          return;
        }
      }
      notebookOpenRef.current = nextOpen;
      setNotebookOpen(nextOpen);
    };
    const onHashChange = () => { void navigate(); };
    window.addEventListener("hashchange", onHashChange);
    return () => { navigation += 1; window.removeEventListener("hashchange", onHashChange); };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("relay-theme", dark ? "dark" : "light");
  }, [dark]);

  // 进入重命名时聚焦并只选中主文件名。
  // 放在 effect 里而不是 onFocus 里，是为了只在开始编辑那一次生效——
  // 否则用户点回输入框想定位光标时，会被重新全选覆盖掉。
  useEffect(() => {
    const input = renameInput.current;
    if (!editingId || !input) return;
    input.focus();
    input.setSelectionRange(0, baseNameEnd(input.value));
  }, [editingId]);

  const notify = useCallback((message: string, kind: "success" | "error" = "success") => {
    const id = ++toastId.current;
    setToast({ id, message, kind });
    window.setTimeout(() => setToast((current) => current?.id === id ? null : current), 2800);
  }, []);

  const markConnected = useCallback(() => {
    setConnectionStatus("online");
    setLastConnectedAt(new Date().toISOString());
  }, []);

  const invalidateStateRead = useCallback((finishLoading = true) => {
    stateRequestId.current += 1;
    stateRequestAbort.current?.abort();
    stateRequestAbort.current = null;
    if (finishLoading) setLoading(false);
  }, []);

  const loadState = useCallback(async ({ force = false, refreshClipboard = false }: StateLoadOptions = {}) => {
    // Manual refresh takes over an older read. Background polling stays quiet
    // instead of creating overlapping state requests.
    if (clipboardWritePending.current && !force) return false;
    if (stateRequestAbort.current) {
      if (!force) return false;
      stateRequestAbort.current.abort();
    }
    const requestId = ++stateRequestId.current;
    const requestedRevision = clipboardEditRevision.current;
    const controller = new AbortController();
    stateRequestAbort.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const next = await api<RelayState>("/api/state", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (requestId !== stateRequestId.current) return false;
      setState(next);
      markConnected();
      if (refreshClipboard || (!dirtyRef.current && !clipboardFocused.current && !composingRef.current)) {
        const settled = settleClipboardRead(draftRef.current, requestedRevision, clipboardEditRevision.current, next.clipboard.content);
        setDraft(settled.draft);
        draftRef.current = settled.draft;
        dirtyRef.current = settled.dirty;
        setDirty(settled.dirty);
        if (!settled.dirty) setClipboardError("");
      }
      return true;
    } catch (error) {
      if (requestId === stateRequestId.current) {
        setConnectionStatus("offline");
        if (refreshClipboard) notify("刷新失败，当前文字已保留，请稍后重试", "error");
      }
      return false;
    } finally {
      window.clearTimeout(timeout);
      if (requestId === stateRequestId.current) {
        stateRequestAbort.current = null;
        setLoading(false);
      }
    }
  }, [markConnected, notify]);

  useEffect(() => {
    void loadState();
    const timer = window.setInterval(() => void loadState(), 10_000);
    const offline = () => setConnectionStatus("offline");
    const online = () => { void loadState(); };
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
      invalidateStateRead(false);
    };
  }, [invalidateStateRead, loadState]);

  const saveClipboard = useCallback(async (silent = false) => {
    if (!dirtyRef.current || composingRef.current || clipboardRefreshPending.current || clipboardWritePending.current) return;
    clipboardWritePending.current = true;
    invalidateStateRead();
    const submittedDraft = draftRef.current;
    setSaving(true);
    try {
      const result = await api<{ clipboard: ClipboardState }>("/api/clipboard", {
        method: "PUT",
        body: JSON.stringify({ content: submittedDraft }),
      });
      const settled = settleClipboardWrite(draftRef.current, submittedDraft, result.clipboard.content);
      draftRef.current = settled.draft;
      dirtyRef.current = settled.dirty;
      setDraft(settled.draft);
      setDirty(settled.dirty);
      setState((current) => ({ ...current, clipboard: result.clipboard }));
      setClipboardError("");
      markConnected();
      if (!silent) notify(settled.dirty ? "已保存，新增文字尚未同步" : "剪贴板已同步到所有设备");
    } catch (error) {
      setClipboardError((error as Error).message);
      setClipboardRetryable(!(error instanceof ApiError) || error.status >= 500 || [408, 429].includes(error.status));
      if (!silent) notify((error as Error).message, "error");
    } finally {
      clipboardWritePending.current = false;
      setSaving(false);
      void loadState({ force: true });
    }
  }, [invalidateStateRead, loadState, markConnected, notify]);

  const syncClipboard = useCallback(async () => {
    const action = clipboardSyncAction(dirtyRef.current, clipboardWritePending.current || clipboardRefreshPending.current, composingRef.current);
    // An explicit click during autosave is remembered, without dimming controls.
    manualSyncQueued.current = action === "wait";
    if (action === "wait") return;
    if (action === "save") return saveClipboard();
    clipboardRefreshPending.current = true;
    setRefreshingClipboard(true);
    try {
      if (await loadState({ force: true, refreshClipboard: true })) notify(dirtyRef.current ? "已刷新，正在编辑的文字已保留" : "已与云端同步");
    } finally {
      clipboardRefreshPending.current = false;
      setRefreshingClipboard(false);
    }
  }, [loadState, notify, saveClipboard]);

  useEffect(() => {
    if (manualSyncQueued.current && !saving && !refreshingClipboard && !composing) void syncClipboard();
  }, [saving, refreshingClipboard, composing, syncClipboard]);

  useEffect(() => {
    const delay = clipboardAutosaveDelay({ dirty, saving, composing, refreshing: refreshingClipboard, failed: Boolean(clipboardError), retryable: clipboardRetryable });
    if (delay === null) return;
    const timer = window.setTimeout(() => void saveClipboard(true), delay);
    return () => window.clearTimeout(timer);
  }, [draft, dirty, saving, composing, refreshingClipboard, clipboardError, clipboardRetryable, saveClipboard]);

  useEffect(() => {
    const flush = () => { if (document.visibilityState === "hidden") void saveClipboard(true); };
    document.addEventListener("visibilitychange", flush);
    return () => document.removeEventListener("visibilitychange", flush);
  }, [saveClipboard]);

  const saveToNotebook = async () => {
    const content = draftRef.current;
    if (!content.trim() || addingNoteRef.current) return;
    addingNoteRef.current = true;
    setAddingNote(true);
    if (noteSnapshot.current?.content !== content) noteSnapshot.current = { id: crypto.randomUUID(), content };
    try {
      await api("/api/notes", { method: "POST", body: JSON.stringify(noteSnapshot.current) });
      noteSnapshot.current = null;
      setNotesRevision((value) => value + 1);
      void loadState({ force: true });
      notify("已存入记事本");
    } catch (error) { notify((error as Error).message, "error"); }
    finally { addingNoteRef.current = false; setAddingNote(false); }
  };

  const copyClipboard = async () => {
    if (!draft) return notify("剪贴板还是空的", "error");
    try {
      await navigator.clipboard.writeText(draft);
      notify("已复制到本机剪贴板");
    } catch {
      notify("浏览器没有允许复制，请手动选择文字", "error");
    }
  };

  const clearClipboard = async () => {
    if (clipboardRefreshPending.current || clipboardWritePending.current) return;
    if (draft && !window.confirm("清空后，其他设备也会看到空白剪贴板。继续吗？")) return;
    clipboardWritePending.current = true;
    invalidateStateRead();
    const submittedDraft = draftRef.current;
    setSaving(true);
    try {
      const result = await api<{ clipboard: ClipboardState }>("/api/clipboard", { method: "DELETE" });
      const settled = settleClipboardWrite(draftRef.current, submittedDraft, result.clipboard.content);
      draftRef.current = settled.draft;
      dirtyRef.current = settled.dirty;
      setDraft(settled.draft);
      setDirty(settled.dirty);
      setState((current) => ({ ...current, clipboard: result.clipboard }));
      markConnected();
      notify(settled.dirty ? "云端已清空，新增文字已保留" : "共享剪贴板已清空");
      setClipboardError("");
    } catch (error) {
      notify((error as Error).message, "error");
    } finally {
      clipboardWritePending.current = false;
      setSaving(false);
      void loadState({ force: true });
    }
  };

  const refreshFiles = async () => {
    if (filesRefreshPending.current) return;
    filesRefreshPending.current = true;
    setRefreshingFiles(true);
    try {
      const refreshed = await loadState({ force: true });
      notify(refreshed ? "文件列表已刷新" : "刷新失败，请稍后重试", refreshed ? "success" : "error");
    } finally {
      filesRefreshPending.current = false;
      setRefreshingFiles(false);
    }
  };

  const updateUpload = (id: string, patch: Partial<UploadTask>) => {
    setUploads((current) => current.map((task) => task.id === id ? { ...task, ...patch } : task));
  };

  // 用实测上行速度的滑动平均驱动并发数，跨批次保留，第二批就不用再从 1 探起。
  const noteLinkSpeed = (bytes: number, elapsedMs: number) => {
    if (bytes <= 0 || elapsedMs <= 0) return;
    const sample = bytes / (elapsedMs / 1000);
    const previous = freshLinkSpeed();
    linkSpeed.current = previous == null ? sample : previous * 0.6 + sample * 0.4;
    linkSpeedAt.current = Date.now();
  };

  // 过期或刚失败过的测速结果一律不信，重新探路。
  const freshLinkSpeed = (): number | null =>
    Date.now() - linkSpeedAt.current <= SPEED_FRESH_MS ? linkSpeed.current : null;

  const forgetLinkSpeed = () => {
    linkSpeed.current = null;
    linkSpeedAt.current = 0;
  };

  const sendOnce = (file: globalThis.File, taskId: string): Promise<UploadOutcome> => new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    const startedAt = Date.now();
    let lastMovedAt = startedAt;
    let sampleAt = startedAt;
    let sampleLoaded = 0;
    let stalled = false;

    // XHR 自带的 timeout 是「总时长」，4 GiB 的文件慢慢传也会被它砍掉。
    // 这里改成看「有没有字节在动」，只有真的卡死才中断。
    const watchdog = window.setInterval(() => {
      if (Date.now() - lastMovedAt < UPLOAD_STALL_MS) return;
      stalled = true;
      xhr.abort();
    }, 5_000);

    const settle = (outcome: UploadOutcome) => {
      window.clearInterval(watchdog);
      activeUploads.current.delete(taskId);
      resolve(outcome);
    };

    activeUploads.current.set(taskId, xhr);
    xhr.open("POST", "/api/files");
    xhr.setRequestHeader("Idempotency-Key", taskId);
    xhr.upload.onprogress = (event) => {
      const now = Date.now();
      lastMovedAt = now;
      if (!event.lengthComputable || event.total <= 0) return;
      const finishedSending = event.total > 0 && event.loaded >= event.total;
      const patch: Partial<UploadTask> = {
        progress: Math.min(99, Math.round(event.loaded / event.total * 100)),
        status: finishedSending ? "processing" : "uploading",
      };
      if (now - sampleAt >= SPEED_SAMPLE_MS) {
        patch.speed = (event.loaded - sampleLoaded) / ((now - sampleAt) / 1000);
        sampleAt = now;
        sampleLoaded = event.loaded;
      }
      updateUpload(taskId, patch);
    };
    xhr.upload.onload = () => {
      lastMovedAt = Date.now();
      updateUpload(taskId, { status: "processing", progress: 99, speed: undefined });
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const result = JSON.parse(xhr.responseText) as { file?: RelayFile };
          if (result.file?.id) {
            noteLinkSpeed(file.size, Date.now() - startedAt);
            settle({ ok: true, file: result.file });
            return;
          }
        } catch { /* handled below */ }
        settle({ ok: false, message: "服务器没有返回文件信息", retryable: true });
        return;
      }
      let message = `上传失败（${xhr.status}）`;
      let code = "";
      try { const data = JSON.parse(xhr.responseText); message = data.error || message; code = data.code || ""; } catch { /* noop */ }
      // 网关类错误多半是链路抖动，值得重试；配额、体积、文件名这些服务器已经给出结论。
      settle({ ok: false, message, retryable: [502, 503, 504].includes(xhr.status) || (xhr.status === 409 && code === "UPLOAD_IN_PROGRESS") });
    };
    xhr.onerror = () => settle({ ok: false, message: "网络连接中断", retryable: true });
    xhr.onabort = () => {
      // 用户主动取消不该被自动重试；只有卡死中断才重试。
      if (cancelled.current.has(taskId)) return settle({ ok: false, message: "已取消", retryable: false });
      settle(stalled
        ? { ok: false, message: `上传停滞超过 ${Math.round(UPLOAD_STALL_MS / 1000)} 秒`, retryable: true }
        : { ok: false, message: "上传已中断", retryable: true });
    };

    const body = new FormData();
    body.append("file", file, file.name);
    xhr.send(body);
  });

  const uploadOne = async (file: globalThis.File, taskId: string): Promise<RelayFile | null> => {
    for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt += 1) {
      if (cancelled.current.has(taskId)) break;
      updateUpload(taskId, { status: "uploading", progress: 0, error: undefined, retryable: undefined, speed: undefined });
      const outcome = await sendOnce(file, taskId);
      if (outcome.ok) {
        // Show each confirmed file immediately. A slow batch or state refresh
        // must not keep a finished upload waiting at 100%.
        invalidateStateRead();
        setState((current) => {
          const existing = current.files.some((item) => item.id === outcome.file.id);
          return {
            ...current,
            files: existing ? current.files.map((item) => item.id === outcome.file.id ? outcome.file : item) : [outcome.file, ...current.files],
            storage: { ...current.storage, usedBytes: current.storage.usedBytes + (existing ? 0 : outcome.file.size) },
          };
        });
        updateUpload(taskId, { progress: 100, status: "done", error: undefined, speed: undefined });
        const timer = window.setTimeout(() => {
          setUploads((current) => current.filter((task) => task.id !== taskId));
          completedUploadTimers.current.delete(timer);
        }, 600);
        completedUploadTimers.current.add(timer);
        return outcome.file;
      }
      if (cancelled.current.has(taskId)) break;
      if (!outcome.retryable || attempt === UPLOAD_MAX_ATTEMPTS) {
        updateUpload(taskId, { status: "error", error: outcome.message, retryable: outcome.retryable, speed: undefined });
        return null;
      }
      // 退避期间把原因留在行里，用户能看到「为什么在等」。下一轮开头会清掉。
      updateUpload(taskId, { error: `${outcome.message}，重试中（${attempt + 1}/${UPLOAD_MAX_ATTEMPTS}）`, speed: undefined });
      await delay(attempt * 1500);
    }
    // 取消过的任务留一个可以手动重来的入口。
    updateUpload(taskId, { status: "error", error: "已取消", retryable: true, speed: undefined });
    cancelled.current.delete(taskId);
    return null;
  };

  const cancelUpload = (taskId: string) => {
    cancelled.current.add(taskId);
    activeUploads.current.get(taskId)?.abort();
    updateUpload(taskId, { status: "error", error: "已取消", retryable: false, speed: undefined });
  };

  // 自适应并发队列：网快就多开几路，一旦出现网络类失败立刻退回串行。
  const runUploadQueue = (items: Array<{ file: globalThis.File; taskId: string }>): Promise<RelayFile[]> =>
    new Promise((resolve) => {
      let cursor = 0;
      let active = 0;
      const uploaded: RelayFile[] = [];
      let degraded = false;
      // 每批都先用一个文件探路。上一批测到的速度不能证明这一刻链路还活着，
      // 而一旦链路是死的，探路只赔上 1 个文件，而不是一次赔上一整批。
      // 探路成功后立刻按实测速度提档，网好的时候这点代价可以忽略。
      let target = 1;

      const pump = () => {
        if (cursor >= items.length && active === 0) {
          resolve(uploaded);
          return;
        }
        while (active < target && cursor < items.length) {
          const item = items[cursor];
          cursor += 1;
          active += 1;
          void uploadOne(item.file, item.taskId).then((file) => {
            active -= 1;
            if (file) {
              uploaded.push(file);
              // 一路顺利就按最新实测速度重新定档，网好的时候能迅速开到上限。
              if (!degraded && !prefersReducedData()) {
                target = Math.max(target, Math.min(concurrencyForSpeed(freshLinkSpeed()), items.length));
              }
            } else {
              // 失败就退回串行，把剩下的文件一个一个稳稳送上去，
              // 并丢掉旧的测速结果——链路刚出过问题，之前那个「很快」已经不作数了。
              degraded = true;
              target = 1;
              forgetLinkSpeed();
            }
            pump();
          });
        }
      };

      if (!items.length) resolve([]);
      else pump();
    });

  const addFiles = async (incoming: FileList | globalThis.File[]): Promise<RelayFile[]> => {
    const files = Array.from(incoming);
    if (!files.length) return [];
    let available = Math.max(0, state.storage.maxBytes - state.storage.usedBytes);
    const accepted = files.filter((file) => {
      if (file.size > state.limits.maxUploadBytes) {
        notify(`${file.name} 超过 ${formatBytes(state.limits.maxUploadBytes)} 单文件限制`, "error");
        return false;
      }
      if (file.size > available) {
        notify(`${file.name} 会超过共享空间的 ${formatBytes(state.storage.maxBytes)} 上限`, "error");
        return false;
      }
      available -= file.size;
      return true;
    });
    if (!accepted.length) return [];
    const tasks = accepted.map((file) => ({
      id: crypto.randomUUID(),
      name: file.name,
      progress: 0,
      status: "queued" as const,
      file,
    }));
    setUploads((current) => [...current, ...tasks]);

    // 批次之间也要排队。否则连着拖两次文件，就变成两条队列各自并发，
    // 弱网下又回到「一起发、一起失败」的老问题。
    const batch = uploadChain.current.then(async () => {
      const uploaded = await runUploadQueue(accepted.map((file, index) => ({ file, taskId: tasks[index].id })));
      void loadState({ force: true });
      const failed = accepted.length - uploaded.length;
      if (!failed) notify(`${uploaded.length} 个文件已放入中转区`);
      else if (!uploaded.length) notify(`${failed} 个文件上传失败，可以点重试`, "error");
      else notify(`${uploaded.length} 个已上传，${failed} 个失败，可以点重试`, "error");
      return uploaded;
    });
    uploadChain.current = batch.then(() => undefined, () => undefined);
    return batch;
  };

  const retryUpload = (taskId: string) => {
    const task = uploads.find((item) => item.id === taskId);
    if (!task || task.status !== "error") return;
    updateUpload(taskId, { status: "queued", progress: 0, error: undefined });
    uploadChain.current = uploadChain.current.then(async () => {
      cancelled.current.delete(taskId);
      const file = await uploadOne(task.file, taskId);
      void loadState({ force: true });
      notify(file ? `${task.name} 已放入中转区` : `${task.name} 仍然失败`, file ? "success" : "error");
    });
  };

  const dismissUpload = (taskId: string) => {
    setUploads((current) => current.filter((task) => task.id !== taskId));
  };

  useEffect(() => {
    const onPaste = (event: globalThis.ClipboardEvent) => {
      // 笔记本有自己的图片粘贴逻辑；普通文件只进入中转首页。
      if (notebookOpenRef.current) return;
      const files = filesFromClipboard(event.clipboardData);
      if (!files.length) return;
      event.preventDefault();
      void addFiles(preparePastedFiles(files));
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [addFiles]);

  const onFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) void addFiles(event.target.files);
    event.target.value = "";
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void addFiles(event.dataTransfer.files);
  };

  const deleteFile = async (file: RelayFile) => {
    if (!window.confirm(`删除“${file.name}”？这会立即从所有设备移除。`)) return;
    try {
      await api<void>(`/api/files/${file.id}`, { method: "DELETE" });
      setSelectedIds((current) => {
        const next = new Set(current);
        next.delete(file.id);
        return next;
      });
      await loadState({ force: true });
      notify("文件已删除");
    } catch (error) {
      notify((error as Error).message, "error");
    }
  };

  const startRename = (file: RelayFile) => {
    setEditingId(file.id);
    setRenameDraft(file.name);
  };

  const cancelRename = () => {
    if (renaming) return;
    setEditingId(null);
    setRenameDraft("");
  };

  const saveRename = async (file: RelayFile) => {
    const name = renameDraft.trim();
    if (!name) return notify("文件名不能为空", "error");
    if (name === file.name) return cancelRename();
    setRenaming(true);
    try {
      const result = await api<{ file: RelayFile }>(`/api/files/${file.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      });
      setState((current) => ({
        ...current,
        files: current.files.map((item) => item.id === file.id ? result.file : item),
      }));
      setEditingId(null);
      setRenameDraft("");
      notify("文件名已更新");
    } catch (error) {
      notify((error as Error).message, "error");
    } finally {
      setRenaming(false);
    }
  };

  const visibleFiles = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const files = state.files.filter((file) => file.name.toLocaleLowerCase().includes(normalized));
    return [...files].sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name, "zh-CN");
      if (sort === "size") return b.size - a.size;
      return b.createdAt.localeCompare(a.createdAt);
    });
  }, [query, sort, state.files]);

  useEffect(() => {
    const existing = new Set(state.files.map((file) => file.id));
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => existing.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [state.files]);

  useEffect(() => {
    if (previewImage && !state.files.some((file) => file.id === previewImage.id)) setPreviewImage(null);
  }, [previewImage, state.files]);

  const allVisibleSelected = visibleFiles.length > 0
    && visibleFiles.every((file) => selectedIds.has(file.id));
  const selectedVisibleCount = visibleFiles.filter((file) => selectedIds.has(file.id)).length;
  const hiddenSelectedCount = selectedIds.size - selectedVisibleCount;

  useEffect(() => {
    if (selectAllInput.current) selectAllInput.current.indeterminate = selectedVisibleCount > 0 && !allVisibleSelected;
  }, [selectedVisibleCount, allVisibleSelected]);

  const clearSelection = () => { setSelectedIds(new Set()); selectionAnchor.current = null; };

  const toggleSelected = (id: string, range = false) => {
    if (batchDeleting) return;
    const anchorIndex = visibleFiles.findIndex((file) => file.id === selectionAnchor.current);
    const targetIndex = visibleFiles.findIndex((file) => file.id === id);
    const rangeIds = range && anchorIndex >= 0 && targetIndex >= 0
      ? visibleFiles.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1).map((file) => file.id)
      : null;
    if (!rangeIds) selectionAnchor.current = id;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (rangeIds) rangeIds.forEach((fileId) => next.add(fileId));
      else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllVisible = () => {
    selectionAnchor.current = null;
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const file of visibleFiles) {
        if (allVisibleSelected) next.delete(file.id);
        else next.add(file.id);
      }
      return next;
    });
  };

  const deleteSelected = async () => {
    const ids = [...selectedIds];
    if (!ids.length) return;
    if (!window.confirm(`确认删除选中的 ${ids.length} 个文件？${hiddenSelectedCount ? `其中 ${hiddenSelectedCount} 个不在当前搜索结果中。` : ""}这会立即从所有设备移除。`)) return;
    setBatchDeleting(true);
    try {
      const result = await api<{
        removedIds: string[];
        storage: RelayState["storage"];
      }>("/api/files", {
        method: "DELETE",
        body: JSON.stringify({ ids }),
      });
      const removed = new Set(result.removedIds);
      setState((current) => ({
        ...current,
        files: current.files.filter((file) => !removed.has(file.id)),
        storage: result.storage,
      }));
      setSelectedIds((current) => new Set([...current].filter((id) => !removed.has(id))));
      notify(`已删除 ${result.removedIds.length} 个文件`);
    } catch (error) {
      notify((error as Error).message, "error");
    } finally {
      setBatchDeleting(false);
    }
  };

  const startBrowserDownload = (url: string) => {
    const link = document.createElement("a");
    link.href = url;
    link.download = "";
    document.body.append(link);
    link.click();
    link.remove();
  };

  const downloadSelected = async () => {
    const ids = state.files.filter((file) => selectedIds.has(file.id)).map((file) => file.id);
    if (!ids.length) return;
    if (ids.length === 1) {
      startBrowserDownload(`/api/files/${ids[0]}/download`);
      return;
    }
    setBatchDownloading(true);
    try {
      const result = await api<{ url: string }>("/api/files/archive", {
        method: "POST",
        body: JSON.stringify({ ids }),
      });
      startBrowserDownload(result.url);
      notify(`正在下载 ${ids.length} 个文件`);
    } catch (error) {
      notify((error as Error).message, "error");
    } finally {
      setBatchDownloading(false);
    }
  };

  const syncStatus = clipboardError ? "error" : dirty || saving || refreshingClipboard ? "pending" : connectionStatus === "online" ? "saved" : "offline";
  const syncDescription = clipboardError ? `同步失败：${clipboardError}` : saving || refreshingClipboard ? "正在同步，仍可继续输入" : dirty ? "有改动，点击保存或等待自动同步" : connectionStatus === "online" ? "已保存；点击获取云端最新内容" : "尚未连接；点击重试";

  return (
    <main className="shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><CloudUpload size={19} strokeWidth={2} /></div>
          <div>
            <strong>Relay</strong>
            <span>文件传输助手</span>
          </div>
        </div>
        <div className="topbar-actions">
          <div className={`connection is-${connectionStatus}`} role="status" title={lastConnectedAt ? `最近连接成功：${relativeTime(lastConnectedAt)}` : "尚未连接成功"}>
            <span />{connectionStatus === "online" ? "已连接" : connectionStatus === "connecting" ? "连接中" : "连接中断"}
          </div>
          <button className="icon-button" onClick={() => setDark((value) => !value)} aria-label="切换明暗主题">
            {dark ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <a className={`button secondary notebook-link ${notebookOpen ? "is-active" : ""}`} href={notebookOpen ? "#" : "#notebook"} aria-label={notebookOpen ? "返回中转首页" : "打开记事本"}><BookOpen size={16} /><span>记事本</span></a>
        </div>
      </header>

      <Notebook ref={notebookRef} open={notebookOpen} revision={notesRevision} files={state.files} onBack={() => { window.location.hash = ""; }} onStorageChange={() => { void loadState({ force: true }); }} onUploadImages={addFiles} notify={notify} />

      <div hidden={notebookOpen}>
      <section className="card clipboard-card">
        <div className="card-heading">
          <div className="heading-copy">
            <div className="section-icon violet"><Clipboard size={19} /></div>
            <div>
              <h2>共享剪贴板</h2>
            </div>
          </div>
          <div className="clipboard-actions">
            <button
              className="button secondary clipboard-note-save"
              onClick={() => void saveToNotebook()}
              disabled={!draft.trim() || addingNote}
            >
              {addingNote ? <LoaderCircle className="spin" size={16} /> : <BookmarkPlus size={16} />}
              {addingNote ? "存入中" : "存到记事本"}
            </button>
          </div>
        </div>

        <textarea
          value={draft}
          onChange={(event) => {
            clipboardEditRevision.current += 1;
            setDraft(event.target.value);
            setClipboardError("");
            draftRef.current = event.target.value;
            dirtyRef.current = event.target.value !== state.clipboard.content;
            setDirty(dirtyRef.current);
          }}
          onCompositionStart={() => { clipboardEditRevision.current += 1; composingRef.current = true; setComposing(true); }}
          onCompositionEnd={() => { composingRef.current = false; setComposing(false); }}
          onFocus={() => { clipboardFocused.current = true; }}
          onBlur={() => { clipboardFocused.current = false; }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void syncClipboard();
            }
          }}
          placeholder="写点什么…"
          aria-label="共享剪贴板内容"
          spellCheck={false}
        />

        <div className="clipboard-footer">
          <span>{draft.length.toLocaleString("zh-CN")} 字符</span>
          <div className="button-row">
            <button className="button ghost danger-ghost" onClick={() => void clearClipboard()} aria-disabled={saving || refreshingClipboard} disabled={!draft && !state.clipboard.content}>
              <Trash2 size={16} /> 清空
            </button>
            <button className="button secondary" onClick={() => void copyClipboard()} disabled={!draft}>
              <Copy size={16} /> 复制
            </button>
            <button
              className="button primary clipboard-sync"
              onClick={() => void syncClipboard()}
              aria-label="保存或刷新剪贴板"
              title={syncDescription}
            >
              <span className={`sync-dot is-${syncStatus}`} role="img" aria-label={syncDescription} />
              保存 / 刷新
            </button>
          </div>
        </div>
      </section>

      <section className="card files-card" aria-label="文件中转区" onKeyDown={(event) => {
        if ((event.target as HTMLElement).closest('textarea, input:not([type="checkbox"]), select')) return;
        if (event.key === "Escape" && !batchDeleting) { event.preventDefault(); clearSelection(); }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a" && !batchDeleting) {
          event.preventDefault();
          setSelectedIds((current) => new Set([...current, ...visibleFiles.map((file) => file.id)]));
        }
      }}>
        <div className="card-heading files-heading">
          <div className="heading-copy">
            <div className="section-icon blue"><Archive size={19} /></div>
            <div>
              <h2>文件中转区</h2>
            </div>
          </div>
          <div className="storage-group">
            <div className="storage-copy">
              <span>{formatBytes(state.storage.usedBytes)} / {formatBytes(state.storage.maxBytes)}</span>
              <div className="storage-track"><span style={{ width: `${Math.min(100, state.storage.usedBytes / state.storage.maxBytes * 100)}%` }} /></div>
            </div>
            <button className="icon-button" onClick={() => void refreshFiles()} disabled={refreshingFiles} aria-label="刷新文件列表" title="刷新">
              <RefreshCw size={17} className={refreshingFiles ? "spin" : undefined} />
            </button>
          </div>
        </div>

        <div
          className={`dropzone ${dragging ? "is-dragging" : ""}`}
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
          }}
          onDrop={onDrop}
        >
          <input ref={fileInput} type="file" multiple hidden onChange={onFileInput} />
          <div className="drop-icon"><CloudUpload size={24} /></div>
          <div className="drop-copy">
            <strong>{dragging ? "松开即可上传" : "拖拽文件到这里"}</strong>
            <span>也可直接粘贴 · 单个最大 {formatBytes(state.limits.maxUploadBytes)}</span>
          </div>
          <button className="button secondary choose-files" type="button" onClick={() => fileInput.current?.click()}>选择文件</button>
        </div>

        {uploads.length > 0 && (
          <div className="upload-stack" aria-live="polite">
            {uploads.map((task) => (
              <div className={`upload-task ${task.status}`} key={task.id}>
                <div className="task-state">
                  {/* 失败用警告图标而不是 ✕：这里是状态指示，不是关闭按钮。
                      右侧那个 ✕ 才是真正能点掉这条记录的。 */}
                  {task.status === "done" ? <Check size={15} /> : task.status === "error" ? <TriangleAlert size={15} /> : task.status === "queued" ? <span className="queued-dot" /> : <LoaderCircle className="spin" size={15} />}
                </div>
                <div className="task-main">
                  <div>
                    <strong>{task.name}</strong>
                    <span>
                      {task.error
                        || (task.status === "queued" ? "等待上传" : task.status === "processing" ? "服务器处理中…" : task.status === "done" ? "已上传" : task.speed ? `${task.progress}% · ${formatBytes(task.speed)}/s` : `${task.progress}%`)}
                    </span>
                  </div>
                  <div className="progress-track"><span style={{ width: `${task.progress}%` }} /></div>
                </div>
                {task.status !== "done" && (
                  <div className="task-actions">
                    {["uploading", "processing"].includes(task.status) && (
                      <button onClick={() => cancelUpload(task.id)} aria-label={`取消上传 ${task.name}`} title="取消">
                        <X size={14} />
                      </button>
                    )}
                    {task.status === "error" && task.retryable && (
                      <button onClick={() => retryUpload(task.id)} aria-label={`重试上传 ${task.name}`} title="重试">
                        <RotateCcw size={14} />
                      </button>
                    )}
                    {task.status === "error" && (
                      <button onClick={() => dismissUpload(task.id)} aria-label={`不再显示 ${task.name}`} title="移除这条记录">
                        <X size={14} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="list-toolbar">
          <label className="search-box">
            <Search size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件" aria-label="搜索文件" />
            {query && <button onClick={() => setQuery("")} aria-label="清除搜索"><X size={14} /></button>}
          </label>
          <select className="sort-select" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} aria-label="文件排序">
            <option value="newest">最新上传</option>
            <option value="name">按名称</option>
            <option value="size">按大小</option>
          </select>
        </div>

        {(state.files.length > 0 || selectedIds.size > 0) && <div className={`file-selection-toolbar ${selectedIds.size ? "has-selection" : ""}`}>
          <div className="selection-summary">
            <label className="select-all">
              <input ref={selectAllInput} type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} disabled={!visibleFiles.length || batchDeleting} aria-label={query ? "全选搜索结果" : "全选文件"} />
              <span>全选</span>
            </label>
            <span className="selection-count" role="status">{selectedIds.size ? `已选 ${selectedIds.size} 项` : `${visibleFiles.length} 个文件`}</span>
            <button className="selection-reset" onClick={clearSelection} disabled={!selectedIds.size || batchDeleting} aria-label="取消选择" title="取消选择（Esc）" style={{ visibility: selectedIds.size ? "visible" : "hidden" }}><X size={15} /></button>
          </div>
          <div className="selection-actions" style={{ visibility: selectedIds.size ? "visible" : "hidden" }}>
            <button className="batch-download" onClick={() => void downloadSelected()} disabled={!selectedIds.size || batchDownloading || batchDeleting} aria-label={`下载 ${selectedIds.size} 项`}>
              {batchDownloading ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />} 下载
            </button>
            <button className="batch-delete" onClick={() => void deleteSelected()} disabled={!selectedIds.size || batchDeleting || batchDownloading} aria-label={`删除 ${selectedIds.size} 项`}>
              {batchDeleting ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />} 删除
            </button>
          </div>
          {hiddenSelectedCount > 0 && <span className="selection-hidden">含 {hiddenSelectedCount} 项搜索范围外的文件</span>}
        </div>}

        <div className="file-list" aria-label="文件列表">
          {loading ? (
            <div className="empty-state"><LoaderCircle className="spin" size={22} /><strong>正在读取</strong></div>
          ) : visibleFiles.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon"><File size={23} /></div>
              <strong>{query ? "没有匹配的文件" : "这里还没有文件"}</strong>
              {query && <button className="button ghost" onClick={() => setQuery("")}>清除搜索</button>}
            </div>
          ) : visibleFiles.map((file) => (
            <article className={`file-row ${selectedIds.has(file.id) ? "is-selected" : ""}`} key={file.id} tabIndex={-1} onClick={(event) => {
              if ((event.target as HTMLElement).closest("button, a, input, label")) return;
              if (editingId) return;
              toggleSelected(file.id, event.shiftKey);
              event.currentTarget.focus({ preventScroll: true });
            }}>
              <label className="row-select">
                <input
                  type="checkbox"
                  checked={selectedIds.has(file.id)}
                  onChange={() => {}}
                  onClick={(event) => toggleSelected(file.id, event.shiftKey)}
                  disabled={batchDeleting}
                  aria-label={`选择 ${file.name}`}
                />
              </label>
              <FileVisual file={file} onPreview={setPreviewImage} />
              <div className="file-info">
                {editingId === file.id ? (
                  <input
                    ref={renameInput}
                    className="rename-input"
                    value={renameDraft}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        if (event.nativeEvent.isComposing) return;
                        event.preventDefault();
                        if (!renaming) void saveRename(file);
                      }
                      if (event.key === "Escape") { event.stopPropagation(); cancelRename(); }
                    }}
                    aria-label={`修改 ${file.name} 的文件名`}
                    maxLength={180}
                  />
                ) : <strong title={file.name}>{file.name}</strong>}
                <span>{formatBytes(file.size)} · {relativeTime(file.createdAt)}</span>
              </div>
              <div className="file-actions">
                {editingId === file.id ? (
                  <>
                    <button className="file-action confirm-action" onClick={() => void saveRename(file)} disabled={renaming || !renameDraft.trim()} title="保存文件名" aria-label={`保存 ${file.name} 的新文件名`}>
                      {renaming ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
                    </button>
                    <button className="file-action" onClick={cancelRename} disabled={renaming} title="取消重命名" aria-label={`取消修改 ${file.name}`}>
                      <X size={16} />
                    </button>
                  </>
                ) : (
                  <>
                    <button className="file-action rename-action" onClick={() => startRename(file)} title="重命名" aria-label={`重命名 ${file.name}`}>
                      <Pencil size={15} />
                    </button>
                    <a className="file-action primary-action" href={`/api/files/${file.id}/download`} title="下载" aria-label={`下载 ${file.name}`}>
                      <Download size={17} />
                    </a>
                    <button className="file-action delete-action" onClick={() => void deleteFile(file)} title="删除" aria-label={`删除 ${file.name}`}>
                      <Trash2 size={16} />
                    </button>
                  </>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>

      </div>
      {previewImage && !notebookOpen && <ImageLightbox key={previewImage.id} image={previewImage} onClose={() => setPreviewImage(null)} />}
      {toast && (
        <div className={`toast ${toast.kind}`} role="status">
          {toast.kind === "success" ? <Check size={16} /> : <X size={16} />}
          {toast.message}
        </div>
      )}
    </main>
  );
}

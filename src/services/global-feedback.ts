export type FeedbackType = "info" | "success" | "warning" | "error";

export interface FeedbackRequest {
  id: string;
  type: FeedbackType;
  message: string;
  duration?: number;
  cooldownMs?: number;
}

export interface FeedbackMessage extends FeedbackRequest {
  duration: number;
  createdAt: number;
}

export interface FeedbackSnapshot {
  current: FeedbackMessage | null;
  queued: number;
}

const DEFAULT_DURATION_MS: Record<FeedbackType, number> = {
  info: 3_000,
  success: 2_800,
  warning: 3_600,
  error: 4_200,
};
const DEFAULT_COOLDOWN_MS = 8_000;
const MAX_QUEUE_SIZE = 5;

let current: FeedbackMessage | null = null;
let queue: FeedbackMessage[] = [];
let snapshot: FeedbackSnapshot = { current: null, queued: 0 };
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
const lastShownAtById = new Map<string, number>();

function publish() {
  snapshot = { current, queued: queue.length };
  for (const listener of listeners) listener();
}

function clearTimer() {
  if (!timer) return;
  clearTimeout(timer);
  timer = null;
}

function scheduleCurrent() {
  clearTimer();
  if (!current) return;
  timer = setTimeout(() => {
    timer = null;
    current = queue.shift() ?? null;
    if (current) lastShownAtById.set(current.id, Date.now());
    publish();
    scheduleCurrent();
  }, current.duration);
}

export function getFeedbackSnapshot() {
  return snapshot;
}

export function subscribeToFeedback(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function showFeedback(request: FeedbackRequest) {
  const message = request.message.trim();
  if (!request.id.trim() || !message) return false;

  const now = Date.now();
  const item: FeedbackMessage = {
    ...request,
    id: request.id.trim(),
    message,
    duration: Math.max(1_200, request.duration ?? DEFAULT_DURATION_MS[request.type]),
    createdAt: now,
  };

  if (current?.id === item.id) {
    if (current.message === item.message && current.type === item.type) return false;
    current = item;
    lastShownAtById.set(item.id, now);
    publish();
    scheduleCurrent();
    return true;
  }

  const queuedIndex = queue.findIndex((queued) => queued.id === item.id);
  if (queuedIndex >= 0) {
    if (
      queue[queuedIndex].message === item.message &&
      queue[queuedIndex].type === item.type
    ) return false;
    queue[queuedIndex] = item;
    publish();
    return true;
  }

  const cooldown = request.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const lastShownAt = lastShownAtById.get(item.id) ?? 0;
  if (now - lastShownAt < cooldown) return false;

  if (!current) {
    current = item;
    lastShownAtById.set(item.id, now);
    publish();
    scheduleCurrent();
    return true;
  }

  if (current.message === item.message || queue.some((queued) => queued.message === item.message)) {
    return false;
  }
  queue = [...queue.slice(-(MAX_QUEUE_SIZE - 1)), item];
  publish();
  return true;
}

export function dismissFeedback(id?: string) {
  if (id && current?.id !== id) {
    const nextQueue = queue.filter((item) => item.id !== id);
    if (nextQueue.length !== queue.length) {
      queue = nextQueue;
      publish();
    }
    return;
  }
  clearTimer();
  current = queue.shift() ?? null;
  if (current) lastShownAtById.set(current.id, Date.now());
  publish();
  scheduleCurrent();
}

export function resetFeedbackForTests() {
  clearTimer();
  current = null;
  queue = [];
  lastShownAtById.clear();
  publish();
}

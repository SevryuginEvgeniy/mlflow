/**
 * ZALABench — клиент сервиса `zalabench-api` для вкладки планировщика (Ф4.2).
 *
 * Данные очереди живут в нашей БД (`zala.*`), MLflow о них не знает,
 * поэтому страница ходит в FastAPI-сервис, а не в MLflow REST.
 *
 * Read-only GET — без токена; управляющие POST — с `Authorization: Bearer`.
 */

/** Базовый URL сервиса; переопределяется через localStorage `zala.apiBase`. */
const DEFAULT_API_BASE = 'http://127.0.0.1:8000';

/** Текущий базовый URL (localStorage читается на каждый запрос). */
export const getApiBase = (): string => {
  try {
    return localStorage.getItem('zala.apiBase') || DEFAULT_API_BASE;
  } catch {
    // localStorage может быть недоступен (приватный режим) — берём дефолт.
    return DEFAULT_API_BASE;
  }
};

/** Ошибка запроса с HTTP-статусом (нужен для E2: 401). */
export class ZalaApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ZalaApiError';
    this.status = status;
  }
}

/** Job очереди (JobOut из zalabench-api). */
export interface ZalaJob {
  jobId: string;
  taskName: string;
  status: string;
  model: string;
  dataset: string;
  scheduledAt: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  attempts: number;
  progressDone: number;
  progressTotal: number | null;
  error: string | null;
  rolledOver: boolean;
}

/** Тело POST /jobs (JobCreate). */
export interface ZalaJobCreate {
  task: string;
  model: string;
  dataset?: string;
  seed?: number;
  epochs?: number;
  scheduledAt?: string;
}

/** Оценка длительности (GET /estimate). */
export interface ZalaEstimate {
  minutes: number;
  source: string;
}

/** Ответ GET /health. */
export interface ZalaHealth {
  status: string;
  checks: Record<string, unknown>;
}

/** Строка JobOut из ответа сервиса (snake_case). */
interface RawJob {
  job_id: string;
  task_name: string;
  status: string;
  model: string;
  dataset: string;
  scheduled_at: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  attempts: number;
  progress_done: number;
  progress_total: number | null;
  error: string | null;
  rolled_over?: boolean;
}

/** snake_case -> camelCase. */
const toZalaJob = (raw: RawJob): ZalaJob => ({
  jobId: raw.job_id,
  taskName: raw.task_name,
  status: raw.status,
  model: raw.model,
  dataset: raw.dataset,
  scheduledAt: raw.scheduled_at,
  createdAt: raw.created_at,
  startedAt: raw.started_at,
  finishedAt: raw.finished_at,
  attempts: raw.attempts,
  progressDone: raw.progress_done,
  progressTotal: raw.progress_total,
  error: raw.error,
  rolledOver: Boolean(raw.rolled_over),
});

/**
 * Запрос к сервису с единым форматом ошибок.
 *
 * FastAPI отдаёт ошибки как `{"detail": ...}`; `detail` бывает строкой
 * или списком (422). Текст ошибки берём из `detail` (E4: 409 показывает его).
 */
const request = async <T>(path: string, init?: RequestInit, token?: string): Promise<T> => {
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) };
  if (init?.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${getApiBase()}${path}`, { ...init, headers });
  } catch (e) {
    // Сетевая ошибка (E1): сервис не запущен или недоступен.
    throw new ZalaApiError(`Сервис недоступен: ${e instanceof Error ? e.message : String(e)}`, 0);
  }

  if (!response.ok) {
    let detail = '';
    try {
      const payload = await response.json();
      const rawDetail = payload?.detail;
      if (typeof rawDetail === 'string') {
        detail = rawDetail;
      } else if (rawDetail !== undefined) {
        detail = JSON.stringify(rawDetail);
      }
    } catch {
      detail = await response.text().catch(() => '');
    }
    throw new ZalaApiError(detail || `HTTP ${response.status}`, response.status);
  }

  try {
    return (await response.json()) as T;
  } catch (e) {
    throw new ZalaApiError(`Некорректный ответ сервиса: ${e instanceof Error ? e.message : String(e)}`, response.status);
  }
};

/** Страница очереди (новые первыми). */
export const listJobs = async (opts?: {
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<{ jobs: ZalaJob[]; total: number }> => {
  const params = new URLSearchParams();
  if (opts?.status) {
    params.set('status', opts.status);
  }
  if (opts?.limit !== undefined) {
    params.set('limit', String(opts.limit));
  }
  if (opts?.offset !== undefined) {
    params.set('offset', String(opts.offset));
  }
  const query = params.toString();
  const payload = await request<{ jobs: RawJob[]; total: number }>(`/jobs${query ? `?${query}` : ''}`);
  return { jobs: (payload.jobs ?? []).map(toZalaJob), total: payload.total ?? 0 };
};

/** Поставить job в очередь. */
export const createJob = async (payload: ZalaJobCreate, token: string): Promise<ZalaJob> => {
  const body: Record<string, unknown> = {
    task: payload.task,
    model: payload.model,
  };
  if (payload.dataset !== undefined) {
    body['dataset'] = payload.dataset;
  }
  if (payload.seed !== undefined) {
    body['seed'] = payload.seed;
  }
  if (payload.epochs !== undefined) {
    body['epochs'] = payload.epochs;
  }
  if (payload.scheduledAt) {
    body['scheduled_at'] = payload.scheduledAt;
  }
  const raw = await request<RawJob>('/jobs', { method: 'POST', body: JSON.stringify(body) }, token);
  return toZalaJob(raw);
};

/** Отменить pending-job. */
export const cancelJob = async (jobId: string, token: string): Promise<ZalaJob> => {
  const raw = await request<RawJob>(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }, token);
  return toZalaJob(raw);
};

/** Повторить failed-job. */
export const retryJob = async (jobId: string, token: string): Promise<ZalaJob> => {
  const raw = await request<RawJob>(`/jobs/${encodeURIComponent(jobId)}/retry`, { method: 'POST' }, token);
  return toZalaJob(raw);
};

/** Оценка длительности по истории (или fallback). */
export const estimateJob = async (task: string, model: string, samples?: number): Promise<ZalaEstimate> => {
  const params = new URLSearchParams({ task, model });
  if (samples !== undefined) {
    params.set('samples', String(samples));
  }
  return request<ZalaEstimate>(`/estimate?${params.toString()}`);
};

/** Состояние сервиса. */
/** Список моделей шлюза (GET /models). */
export const listModels = async (): Promise<string[]> => {
  const data = await request<{ models: string[] }>('/models');
  return data.models;
};

/** Список доступных тасков (GET /tasks). */
export const listTasks = async (): Promise<string[]> => {
  const data = await request<{ tasks: string[] }>('/tasks');
  return data.tasks;
};

export const apiHealth = async (): Promise<ZalaHealth> => {
  return request<ZalaHealth>('/health');
};

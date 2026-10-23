/**
 * ZALABench — клиент сервиса `zalabench-api` для вкладки планировщика (Ф4.2).
 *
 * Данные очереди живут в нашей БД (`zala.*`), MLflow о них не знает,
 * поэтому страница ходит в FastAPI-сервис, а не в MLflow REST.
 *
 * Read-only GET — без токена; управляющие POST — с `Authorization: Bearer`.
 */

/**
 * Базовый URL сервиса.
 *
 * Приоритет источников:
 * 1. `localStorage['zala.apiBase']` — ручное переопределение без пересборки;
 * 2. build-time `REACT_APP_ZALA_API_BASE` — абсолютный URL (прод за прокси);
 * 3. вычисление от адреса страницы: тот же хост, порт из
 *    `REACT_APP_ZALA_API_PORT` (по умолчанию 8000).
 *
 * Вариант 3 убирает хардкод `127.0.0.1`: UI, открытый по IP или имени
 * хоста, обращается к API на том же хосте, а не к localhost браузера.
 */
const BUILD_API_BASE = (process.env['REACT_APP_ZALA_API_BASE'] || '').trim();
const BUILD_API_PORT = (process.env['REACT_APP_ZALA_API_PORT'] || '8000').trim();

/** Базовый URL по умолчанию: build-time env или адрес страницы + порт API. */
const defaultApiBase = (): string => {
  if (BUILD_API_BASE) {
    return BUILD_API_BASE.replace(/\/+$/, '');
  }
  if (typeof window !== 'undefined' && window.location) {
    return `${window.location.protocol}//${window.location.hostname}:${BUILD_API_PORT}`;
  }
  return `http://127.0.0.1:${BUILD_API_PORT}`;
};

/** Текущий базовый URL (localStorage читается на каждый запрос). */
export const getApiBase = (): string => {
  try {
    // Ключ намеренно плоский (`zala.apiBase`), а не `useLocalStorage`-формат
    // с версией: переопределение задаётся вручную из консоли/доков.
    // eslint-disable-next-line @databricks/no-direct-storage -- ручной override вне React
    return localStorage.getItem('zala.apiBase') || defaultApiBase();
  } catch {
    // localStorage может быть недоступен (приватный режим) — берём дефолт.
    return defaultApiBase();
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
  /** MLflow-эксперимент прогона (Ф5.6). */
  experiment: string;
  /** Ф5.2: составной прогон, к которому относится задача (`null` — одиночная). */
  groupId: string | null;
  /** Ф5.8e: приоритет очереди 0..10 (больше = раньше). */
  priority: number;
  /** Ф5.8e: watchdog задачи в секундах (`null` — без лимита). */
  timeLimitS: number | null;
  /** Ф5.8e: роли моделей (`judge`/`grader`/`user`) -> кластерный алиас. */
  modelRoles: Record<string, string>;
  /**
   * Ф5.8d S2 (#20): сколько pending-задач того же кластера впереди.
   *
   * Ненулевое значение у pending judge-job значит «кластер-судья занят»:
   * оценка появится после этих задач.
   */
  queueAhead: number;
}

/** Тело POST /jobs (JobCreate). */
export interface ZalaJobCreate {
  task: string;
  model: string;
  dataset?: string;
  seed?: number;
  epochs?: number;
  scheduledAt?: string;
  /** MLflow-эксперимент прогона (Ф5.6); по умолчанию `zalabench`. */
  experiment?: string;
  /** Ручки генерации (Ф5.1): temperature, max_tokens, reasoning_effort, ... */
  knobs?: Record<string, unknown>;
  /**
   * Ф5.2: составной прогон — N датасетов с общим `group_id`.
   *
   * Задан и непуст -> сервис создаёт N задач (по одной на датасет), `task`
   * определяется автоматически по имени датасета. Иначе — обычная задача.
   */
  datasets?: string[];
  /** Ф5.8e: приоритет очереди 0..10 (больше = раньше). */
  priority?: number;
  /** Ф5.8e: watchdog задачи в секундах. */
  timeLimitS?: number;
  /** Ф5.8e: роли моделей (`judge`/`grader`/`user`) -> имя модели шлюза. */
  modelRoles?: Record<string, string>;
}

/** Тело POST /judge (Ф5.1): судейство прогона из UI. */
export interface ZalaJudgeCreate {
  runId: string;
  judgeModel: string;
  kinds: Array<'single' | 'pairwise' | 'trajectory'>;
  referenceRunId?: string;
  experiment?: string;
  /**
   * Ф5.8d S1 (#19): разрешить судье оценивать собственный прогон.
   *
   * По умолчанию сервис отвечает 422 при совпадении судьи с моделью
   * прогона. `true` — job ставится, имя модели вычищается из промпта,
   * вердикты помечаются `zala.judge.self` и в рейтинг не идут.
   */
  allowSelfJudge?: boolean;
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
  experiment?: string;
  group_id?: string | null;
  priority?: number;
  time_limit_s?: number | null;
  model_roles?: Record<string, string>;
  queue_ahead?: number;
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
  experiment: raw.experiment || 'zalabench',
  groupId: raw.group_id ?? null,
  priority: raw.priority ?? 0,
  timeLimitS: raw.time_limit_s ?? null,
  modelRoles: raw.model_roles ?? {},
  queueAhead: raw.queue_ahead ?? 0,
});

/**
 * Запрос к сервису с единым форматом ошибок.
 *
 * FastAPI отдаёт ошибки как `{"detail": ...}`; `detail` бывает строкой
 * или списком (422). Текст ошибки берём из `detail` (E4: 409 показывает его).
 */
const request = async <T>(path: string, init?: RequestInit, token?: string): Promise<T> => {
  const headers: Record<string, string> = {};
  Object.assign(headers, (init?.headers as Record<string, string>) ?? {});
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

/**
 * `datetime-local` -> ISO UTC с явной зоной.
 *
 * `<input type="datetime-local">` отдаёт naive-строку без зоны
 * (`2026-10-22T08:40`). Если отправить её как есть, сервер трактует время
 * в СВОЕЙ зоне (в контейнере это UTC), и пользователь получает сдвиг на
 * величину своего смещения (для UTC+4 — 4 часа вперёд). Здесь браузер
 * интерпретирует строку в локальной зоне пользователя и переводит в UTC.
 */
const toLocalIso = (value: string): string => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toISOString();
};

/** Поставить job в очередь. */
export const createJob = async (payload: ZalaJobCreate, token: string): Promise<ZalaJob> => {
  const body: Record<string, unknown> = {};
  body['task'] = payload.task;
  body['model'] = payload.model;
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
    body['scheduled_at'] = toLocalIso(payload.scheduledAt);
  }
  if (payload.experiment) {
    body['experiment'] = payload.experiment;
  }
  if (payload.knobs && Object.keys(payload.knobs).length > 0) {
    body['knobs'] = payload.knobs;
  }
  if (payload.datasets && payload.datasets.length > 0) {
    body['datasets'] = payload.datasets;
  }
  if (payload.priority !== undefined) {
    body['priority'] = payload.priority;
  }
  if (payload.timeLimitS !== undefined) {
    body['time_limit_s'] = payload.timeLimitS;
  }
  if (payload.modelRoles && Object.keys(payload.modelRoles).length > 0) {
    body['model_roles'] = payload.modelRoles;
  }
  const raw = await request<RawJob>('/jobs', { method: 'POST', body: JSON.stringify(body) }, token);
  return toZalaJob(raw);
};

/** Один прогон внутри составного прогона (GroupRunOut). */
export interface ZalaGroupRun {
  runId: string;
  runName: string;
  dataset: string;
  task: string;
  model: string;
  status: string;
  /** Метрика прогона (`inspect.accuracy`); `null` — нет данных. */
  score: number | null;
  samples: number;
}

/** Агрегат составного прогона (GroupOut, Ф5.2). */
export interface ZalaGroup {
  groupId: string;
  /** Взвешенное по сэмплам среднее; `null` — прогонов с метрикой ещё нет. */
  score: number | null;
  ciLower: number | null;
  ciUpper: number | null;
  samples: number;
  /** `false` — внутри группы различаются scoring/judge, агрегат читать нельзя. */
  comparable: boolean;
  /** Поля N-X, различие которых ломает сравнимость (scoring/judge). */
  incomparableFields: string[];
  /** Все различающиеся поля N-X (dataset/ground_truth/prompts — норма). */
  nxDiffFields: string[];
  runs: ZalaGroupRun[];
}

/** Строка GroupRunOut в ответе сервиса (snake_case). */
interface RawGroupRun {
  run_id: string;
  run_name: string;
  dataset: string;
  task: string;
  model: string;
  status: string;
  score: number | null;
  samples: number;
}

/** Ответ GET /groups/{id} (snake_case). */
interface RawGroup {
  group_id: string;
  score: number | null;
  ci_lower: number | null;
  ci_upper: number | null;
  samples: number;
  comparable: boolean;
  incomparable_fields?: string[];
  nx_diff_fields?: string[];
  runs?: RawGroupRun[];
}

/** snake_case -> camelCase (GroupOut). */
const toZalaGroup = (raw: RawGroup): ZalaGroup => ({
  groupId: raw.group_id,
  score: raw.score,
  ciLower: raw.ci_lower,
  ciUpper: raw.ci_upper,
  samples: raw.samples,
  comparable: raw.comparable,
  incomparableFields: raw.incomparable_fields ?? [],
  nxDiffFields: raw.nx_diff_fields ?? [],
  runs: (raw.runs ?? []).map((run) => ({
    runId: run.run_id,
    runName: run.run_name,
    dataset: run.dataset,
    task: run.task,
    model: run.model,
    status: run.status,
    score: run.score,
    samples: run.samples,
  })),
});

/**
 * Поставить составной прогон (Ф5.2): N задач с общим `group_id`.
 *
 * Сервис отвечает `{"group_id": ..., "jobs": [...]}` вместо одного JobOut.
 * Валидация всех датасетов идёт до первой постановки: при 422 в очередь
 * не попадает ни одна задача.
 */
export const createGroupJobs = async (
  payload: Omit<ZalaJobCreate, 'task' | 'dataset'> & { datasets: string[] },
  token: string,
): Promise<{ groupId: string; jobs: ZalaJob[] }> => {
  const body: Record<string, unknown> = {};
  // `task`/`dataset` сервис игнорирует при непустом `datasets`, но
  // JobCreate требует их присутствия (Pydantic) — шлём первый датасет.
  body['task'] = payload.datasets[0] ?? '';
  body['dataset'] = payload.datasets[0] ?? '';
  body['datasets'] = payload.datasets;
  body['model'] = payload.model;
  if (payload.seed !== undefined) {
    body['seed'] = payload.seed;
  }
  if (payload.epochs !== undefined) {
    body['epochs'] = payload.epochs;
  }
  if (payload.scheduledAt) {
    body['scheduled_at'] = toLocalIso(payload.scheduledAt);
  }
  if (payload.experiment) {
    body['experiment'] = payload.experiment;
  }
  if (payload.knobs && Object.keys(payload.knobs).length > 0) {
    body['knobs'] = payload.knobs;
  }
  if (payload.priority !== undefined) {
    body['priority'] = payload.priority;
  }
  if (payload.timeLimitS !== undefined) {
    body['time_limit_s'] = payload.timeLimitS;
  }
  if (payload.modelRoles && Object.keys(payload.modelRoles).length > 0) {
    body['model_roles'] = payload.modelRoles;
  }
  const raw = await request<{ group_id: string; jobs: RawJob[] }>(
    '/jobs',
    { method: 'POST', body: JSON.stringify(body) },
    token,
  );
  return { groupId: raw.group_id, jobs: (raw.jobs ?? []).map(toZalaJob) };
};

/**
 * Агрегат составного прогона (GET /groups/{group_id}, Ф5.2).
 *
 * Группа собирается по тегу `zala.group_id` на run'ах MLflow; пока прогоны
 * не появились, сервис отдаёт агрегат без метрик (`score = null`).
 * Неизвестная группа -> ZalaApiError(status=404).
 */
export const getGroup = async (groupId: string): Promise<ZalaGroup> => {
  const raw = await request<RawGroup>(`/groups/${encodeURIComponent(groupId)}`);
  return toZalaGroup(raw);
};

/**
 * Поставить судейство прогона (Ф5.1): job `task="judge"`.
 *
 * Его берёт свободный воркер модели-судьи; результат — вердикты в MLflow
 * (Assessments на трейсах прогона).
 */
export const createJudgeJob = async (
  payload: ZalaJudgeCreate,
  token: string,
): Promise<ZalaJob> => {
  const body: Record<string, unknown> = {};
  body['run_id'] = payload.runId;
  body['judge_model'] = payload.judgeModel;
  body['kinds'] = payload.kinds;
  if (payload.referenceRunId) {
    body['reference_run_id'] = payload.referenceRunId;
  }
  if (payload.experiment) {
    body['experiment'] = payload.experiment;
  }
  if (payload.allowSelfJudge) {
    body['allow_self_judge'] = true;
  }
  const response = await request<{ job: RawJob; judge_model: string }>(
    '/judge',
    { method: 'POST', body: JSON.stringify(body) },
    token,
  );
  return toZalaJob(response.job);
};

/**
 * Отменить job (Ф5 §8.2).
 *
 * `pending` -> сразу `cancelled`; `running` -> кооперативная отмена: сервис
 * ставит флаг, статус меняется после того, как воркер завершит прогон.
 */
export const cancelJob = async (jobId: string, token: string): Promise<ZalaJob> => {
  const raw = await request<RawJob>(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }, token);
  return toZalaJob(raw);
};

/**
 * Удалить строку очереди (Ф5 §8.1).
 *
 * MLflow run и `.eval`-лог остаются. `running` -> 409: сначала отмена.
 */
export const deleteJob = async (jobId: string, token: string): Promise<{ deleted: number }> => {
  return request<{ deleted: number }>(`/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' }, token);
};

/** Массовое удаление по статусу (Ф5 §8.1). Возвращает число удалённых строк. */
export const clearQueue = async (status: string, token: string): Promise<{ deleted: number }> => {
  const params = new URLSearchParams({ status });
  return request<{ deleted: number }>(`/jobs?${params.toString()}`, { method: 'DELETE' }, token);
};

/** Повторить failed-job. */
export const retryJob = async (jobId: string, token: string): Promise<ZalaJob> => {
  const raw = await request<RawJob>(`/jobs/${encodeURIComponent(jobId)}/retry`, { method: 'POST' }, token);
  return toZalaJob(raw);
};

/** Оценка длительности по истории (или fallback). */
export const estimateJob = async (
  task: string,
  model: string,
  samples?: number,
  dataset?: string,
): Promise<ZalaEstimate> => {
  const params = new URLSearchParams({ task, model });
  if (samples !== undefined) {
    params.set('samples', String(samples));
  }
  if (dataset) {
    params.set('dataset', dataset);
  }
  return request<ZalaEstimate>(`/estimate?${params.toString()}`);
};

/** MLflow-эксперимент (Ф5.6). */
export interface ZalaExperiment {
  name: string;
  experimentId: string;
}

/** Список экспериментов (GET /experiments) — для выпадающего списка. */
export const listExperiments = async (): Promise<ZalaExperiment[]> => {
  const data = await request<{ experiments: { name: string; experiment_id: string }[] }>('/experiments');
  return (data.experiments ?? []).map((item) => ({
    name: item.name,
    experimentId: item.experiment_id,
  }));
};

/** Создать эксперимент (POST /experiments); дубль -> 409 (ZalaApiError). */
export const createExperiment = async (name: string, token: string): Promise<ZalaExperiment> => {
  const raw = await request<{ name: string; experiment_id: string }>(
    '/experiments',
    { method: 'POST', body: JSON.stringify({ name }) },
    token,
  );
  return { name: raw.name, experimentId: raw.experiment_id };
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

/**
 * Один сэмпл прогона (GET /runs/{run_id}/samples, Ф5.8c J2/J6/J7).
 *
 * `judge*` — вердикт нашего судьи и его токены из аудита `judge_calls.jsonl`.
 * `null` означает «не оценивалось», а не ноль: UI показывает прочерк.
 */
export interface ZalaRunSample {
  sampleId: string;
  input: string;
  output: string;
  target: string | null;
  score: number | null;
  scorerName: string | null;
  verdict: unknown;
  explanation: string | null;
  judgeModel: string | null;
  judgeScore: number | null;
  judgeRationale: string | null;
  judgeKind: string | null;
  judgeInputTokens: number | null;
  judgeOutputTokens: number | null;
}

/** Строка RunSampleOut из ответа сервиса (snake_case). */
interface RawRunSample {
  sample_id: string;
  input: string;
  output: string;
  target?: string | null;
  score?: number | null;
  scorer_name?: string | null;
  verdict?: unknown;
  explanation?: string | null;
  judge_model?: string | null;
  judge_score?: number | null;
  judge_rationale?: string | null;
  judge_kind?: string | null;
  judge_input_tokens?: number | null;
  judge_output_tokens?: number | null;
}

/** Сэмплы прогона: оба вердикта (scorer + судья) и токены судьи. */
export const getRunSamples = async (runId: string): Promise<ZalaRunSample[]> => {
  const data = await request<{ run_id: string; samples: RawRunSample[] }>(
    `/runs/${encodeURIComponent(runId)}/samples`,
  );
  return (data.samples ?? []).map((raw) => ({
    sampleId: raw.sample_id,
    input: raw.input,
    output: raw.output,
    target: raw.target ?? null,
    score: raw.score ?? null,
    scorerName: raw.scorer_name ?? null,
    verdict: raw.verdict ?? null,
    explanation: raw.explanation ?? null,
    judgeModel: raw.judge_model ?? null,
    judgeScore: raw.judge_score ?? null,
    judgeRationale: raw.judge_rationale ?? null,
    judgeKind: raw.judge_kind ?? null,
    judgeInputTokens: raw.judge_input_tokens ?? null,
    judgeOutputTokens: raw.judge_output_tokens ?? null,
  }));
};

export const apiHealth = async (): Promise<ZalaHealth> => {
  return request<ZalaHealth>('/health');
};

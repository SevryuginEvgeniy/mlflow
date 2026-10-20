/**
 * ZALABench — клиент MLflow REST для обзорной вкладки (Ф3.7).
 *
 * Страница только читает данные, поэтому ходим напрямую в MLflow REST:
 * - `POST /api/2.0/mlflow/runs/search` — прогоны с метриками/параметрами/тегами;
 * - `POST /ajax-api/3.0/mlflow/traces/search` — трейсы вместе с Assessments.
 *
 * Внимание: traces/search понимает только `locations[]`; payload с
 * `experiment_ids` возвращает 0 результатов (проверено).
 */

/** Сводка одного прогона для таблицы и деталей. */
export interface ZalaRunSummary {
  runId: string;
  runName: string;
  model: string;
  dataset: string;
  status: string;
  /** Время старта, мс с epoch (как отдаёт MLflow). */
  startTime: number;
  /** Все метрики прогона (ключ → значение), включая `zala.*`. */
  metrics: Record<string, number>;
  /** Все теги прогона (ключ → значение), включая `zala.*`. */
  tags: Record<string, string>;
  /**
   * Параметры прогона (ключ → значение); расширение контракта — нужны
   * для фильтра трейсов по `eval_id`.
   */
  params?: Record<string, string>;
}

/** Один вердикт судьи, привязанный к трейсу. */
export interface ZalaAssessment {
  name: string;
  value: number | null;
  rationale: string;
  sourceType: string;
  sourceId: string;
}

/** Трейс прогона (сэмпл) с вердиктами. */
export interface ZalaTrace {
  traceId: string;
  sampleId: string;
  evalId: string;
  assessments: ZalaAssessment[];
}

/** Лимит выборки прогонов (E5: >100 → в UI пометка «показаны первые 100»). */
export const ZALA_RUNS_LIMIT = 100;
/** Лимит выборки трейсов. */
export const ZALA_TRACES_LIMIT = 100;

/** Строка прогона из ответа MLflow (только используемые поля). */
interface MlflowRun {
  info?: {
    run_id?: string;
    run_name?: string;
    status?: string;
    start_time?: number;
  };
  data?: {
    metrics?: Array<{ key: string; value: number }>;
    params?: Array<{ key: string; value: string }>;
    tags?: Array<{ key: string; value: string }>;
  };
}

/** Трейс из ответа MLflow (только используемые поля). */
interface MlflowTrace {
  trace_id?: string;
  tags?: Record<string, string>;
  assessments?: Array<{
    assessment_name?: string;
    source?: { source_type?: string; source_id?: string };
    feedback?: { value?: number };
    rationale?: string;
  }>;
}

/** Преобразует массив `{key, value}` в объект. */
const keyValueToRecord = <T>(items?: Array<{ key: string; value: T }>): Record<string, T> => {
  const result: Record<string, T> = {};
  (items ?? []).forEach(({ key, value }) => {
    result[key] = value;
  });
  return result;
};

/** POST JSON с единым форматом ошибок (E3 — страница покажет текст). */
const postJson = async <T>(url: string, body: unknown): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`MLflow недоступен: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!response.ok) {
    // Тело ошибки MLflow — JSON с полем `message`; если не разобралось, берём текст.
    let detail = '';
    try {
      const payload = await response.json();
      detail = payload?.message ?? JSON.stringify(payload);
    } catch {
      detail = await response.text().catch(() => '');
    }
    throw new Error(`MLflow вернул ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  try {
    return (await response.json()) as T;
  } catch (e) {
    throw new Error(`Некорректный ответ MLflow: ${e instanceof Error ? e.message : String(e)}`);
  }
};

/**
 * Ищет прогоны эксперимента. Возвращает не больше `ZALA_RUNS_LIMIT` штук;
 * страница считает E5 по `runs.length >= ZALA_RUNS_LIMIT`.
 */
export const searchZalaRuns = async (experimentId: string): Promise<ZalaRunSummary[]> => {
  const payload = await postJson<{ runs?: MlflowRun[] }>('/api/2.0/mlflow/runs/search', {
    experiment_ids: [experimentId],
    max_results: ZALA_RUNS_LIMIT,
  });
  const rawRuns = payload.runs ?? [];
  const runs = rawRuns.map((run): ZalaRunSummary => {
    const metrics = keyValueToRecord(run.data?.metrics);
    const params = keyValueToRecord(run.data?.params);
    const tags = keyValueToRecord(run.data?.tags);
    return {
      runId: run.info?.run_id ?? '',
      runName: run.info?.run_name || run.info?.run_id || '—',
      model: params['model'] || params['zala.model'] || tags['zala.run_config.model'] || '—',
      dataset: params['dataset'] || params['zala.nx.dataset'] || tags['zala.nx.dataset'] || '—',
      status: run.info?.status ?? '—',
      startTime: run.info?.start_time ?? 0,
      metrics,
      tags,
      params,
    };
  });
  return runs;
};

/**
 * Ищет трейсы эксперимента вместе с Assessments.
 *
 * `filter` — необязательное выражение MLflow (например, по `inspect.eval_id`);
 * добавляется в payload как есть.
 */
export const searchZalaTraces = async (experimentId: string, filter?: string): Promise<ZalaTrace[]> => {
  const body: Record<string, unknown> = {
    locations: [{ type: 'MLFLOW_EXPERIMENT', mlflow_experiment: { experiment_id: experimentId } }],
    max_results: ZALA_TRACES_LIMIT,
  };
  if (filter) {
    body['filter'] = filter;
  }
  const payload = await postJson<{ traces?: MlflowTrace[] }>('/ajax-api/3.0/mlflow/traces/search', body);
  return (payload.traces ?? []).map((trace): ZalaTrace => {
    const tags = trace.tags ?? {};
    return {
      traceId: trace.trace_id ?? '',
      sampleId: tags['inspect.sample_id'] || tags['zala.judge.sample_id'] || '—',
      evalId: tags['inspect.eval_id'] || '',
      assessments: (trace.assessments ?? []).map((assessment) => ({
        name: assessment.assessment_name ?? '—',
        value: typeof assessment.feedback?.value === 'number' ? assessment.feedback.value : null,
        rationale: assessment.rationale ?? '',
        sourceType: assessment.source?.source_type ?? '—',
        sourceId: assessment.source?.source_id ?? '—',
      })),
    };
  });
};

/** Экранирует значение для строкового литерала в фильтре MLflow. */
export const quoteFilterValue = (value: string): string => `'${value.replace(/'/g, "\\'")}'`;

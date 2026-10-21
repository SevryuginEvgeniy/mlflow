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
 * Имя датасета прогона.
 *
 * Отдельного `params.dataset` в MLflow нет: `run_eval` кладёт имя внутрь
 * JSON-параметра `metadata` (`zala_run_config.dataset`), а `zala.nx.dataset` —
 * это хеш снапшота, не имя. Порядок: `params.dataset` (если появится) →
 * `metadata.zala_run_config.dataset` → хеш снапшота → «—».
 */
const resolveDatasetName = (params: Record<string, string>, tags: Record<string, string>): string => {
  if (params['dataset']) {
    return params['dataset'];
  }
  try {
    const metadata = params['metadata'] ? JSON.parse(params['metadata']) : null;
    const name = metadata?.zala_run_config?.dataset;
    if (typeof name === 'string' && name) {
      return name;
    }
  } catch {
    // Битый JSON метаданных — не повод ломать таблицу.
  }
  return tags['zala.nx.dataset'] || tags['zala.dataset'] || '—';
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
      dataset: resolveDatasetName(params, tags),
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

// ---------------------------------------------------------------------------
// Ф4.3 — каналы, штампы N-X, artifact metrics.json
// ---------------------------------------------------------------------------

/** Одна метрика внутри канала (значение + CI + статус). */
export interface ZalaChannelMetric {
  name: string;
  value: number | null;
  ciLower: number | null;
  ciUpper: number | null;
  status: string;
}

/** Разбивка метрик по каналу (`task_type`). */
export interface ZalaChannel {
  channel: string;
  metrics: ZalaChannelMetric[];
  /** Число сэмплов канала — есть только в `metrics.json` (`n_samples`). */
  nSamples?: number;
}

/** Штамп N-X прогона (5 полей `zala.nx.*`) + хеш судейского штампа. */
export interface ZalaStamp {
  dataset: string;
  scoring: string;
  judge: string;
  groundTruth: string;
  prompts: string;
  /** `zala.judge.stamp`; пустая строка — тега нет (судейские метрики неизвестны). */
  judgeStamp?: string;
}

/** Результат сравнения штампов: `diffs` — имена различающихся полей. */
export interface ZalaStampDiff {
  comparable: boolean;
  diffs: string[];
  /** Дополнительно: различается именно `zala.judge.stamp` (судейские метрики). */
  judgeStampDiffers?: boolean;
}

/** Префиксы метрик прогона (статические и судейские). */
const METRIC_PREFIXES = ['zala.metric.', 'zala.judge.'];
/** Маркер разбивки по каналам в имени метрики. */
const TASK_TYPE_MARKER = '.task_type.';
/** Суффикс статуса (живёт в тегах, а не в метриках). */
const STATUS_SUFFIX = '.status';

/** Читает штамп N-X из тегов прогона (отсутствующие поля — пустая строка). */
export const readStamp = (tags: Record<string, string>): ZalaStamp => ({
  dataset: tags['zala.nx.dataset'] ?? '',
  scoring: tags['zala.nx.scoring'] ?? '',
  judge: tags['zala.nx.judge'] ?? '',
  groundTruth: tags['zala.nx.ground_truth'] ?? '',
  prompts: tags['zala.nx.prompts'] ?? '',
  judgeStamp: tags['zala.judge.stamp'] ?? '',
});

/**
 * Сравнивает штампы двух прогонов.
 *
 * `diffs` содержит имена полей `zala.nx.*` (`dataset`, `scoring`, `judge`,
 * `ground_truth`, `prompts`) и `judge` — при различии `zala.judge.stamp`
 * (судейские метрики сравнимы только при совпадении обоих штампов).
 */
export const compareStamps = (a: ZalaStamp, b: ZalaStamp): ZalaStampDiff => {
  const diffs: string[] = [];
  const nxFields: Array<[string, string, string]> = [
    ['dataset', a.dataset, b.dataset],
    ['scoring', a.scoring, b.scoring],
    ['judge', a.judge, b.judge],
    ['ground_truth', a.groundTruth, b.groundTruth],
    ['prompts', a.prompts, b.prompts],
  ];
  nxFields.forEach(([name, left, right]) => {
    if (left !== right && !diffs.includes(name)) {
      diffs.push(name);
    }
  });
  const judgeStampDiffers = (a.judgeStamp ?? '') !== (b.judgeStamp ?? '');
  if (judgeStampDiffers && !diffs.includes('judge')) {
    diffs.push('judge');
  }
  return { comparable: diffs.length === 0, diffs, judgeStampDiffers };
};

/** Разбирает имя ключа канала: `zala.metric.<name>.task_type.<channel>`. */
const parseChannelKey = (key: string): { name: string; channel: string } | null => {
  const prefix = METRIC_PREFIXES.find((candidate) => key.startsWith(candidate));
  if (!prefix) {
    return null;
  }
  const markerIndex = key.indexOf(TASK_TYPE_MARKER);
  if (markerIndex < 0) {
    return null;
  }
  const name = key.slice(prefix.length, markerIndex);
  const channel = key.slice(markerIndex + TASK_TYPE_MARKER.length);
  if (!name || !channel) {
    return null;
  }
  return { name, channel };
};

/**
 * Группирует `zala.metric.<name>.task_type.<type>` по каналам.
 *
 * Fallback для случая, когда artifact `metrics.json` недоступен (E4):
 * значения и CI берутся из метрик, статусы — из тегов
 * `...task_type.<type>.status` (статусные метрики значения не имеют).
 */
export const parseChannels = (
  metrics: Record<string, number>,
  tags: Record<string, string>,
): ZalaChannel[] => {
  const channels = new Map<string, Map<string, ZalaChannelMetric>>();
  const ensure = (channel: string, name: string): ZalaChannelMetric => {
    const metricMap = channels.get(channel) ?? new Map<string, ZalaChannelMetric>();
    channels.set(channel, metricMap);
    const existing = metricMap.get(name);
    if (existing) {
      return existing;
    }
    const created: ZalaChannelMetric = { name, value: null, ciLower: null, ciUpper: null, status: 'ok' };
    metricMap.set(name, created);
    return created;
  };

  Object.entries(metrics).forEach(([key, value]) => {
    // Границы CI — отдельные ключи, приклеиваем к базовой метрике.
    if (key.endsWith('.ci_lower') || key.endsWith('.ci_upper')) {
      const isLower = key.endsWith('.ci_lower');
      const baseKey = key.slice(0, isLower ? -'.ci_lower'.length : -'.ci_upper'.length);
      const parsed = parseChannelKey(baseKey);
      if (!parsed) {
        return;
      }
      const metric = ensure(parsed.channel, parsed.name);
      if (isLower) {
        metric.ciLower = value;
      } else {
        metric.ciUpper = value;
      }
      return;
    }
    const parsed = parseChannelKey(key);
    if (!parsed) {
      return;
    }
    ensure(parsed.channel, parsed.name).value = value;
  });

  Object.entries(tags).forEach(([key, status]) => {
    if (!key.endsWith(STATUS_SUFFIX)) {
      return;
    }
    const parsed = parseChannelKey(key.slice(0, -STATUS_SUFFIX.length));
    if (!parsed) {
      return;
    }
    ensure(parsed.channel, parsed.name).status = status;
  });

  return Array.from(channels.entries())
    .map(([channel, metricMap]) => ({
      channel,
      metrics: Array.from(metricMap.values()).sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.channel.localeCompare(b.channel));
};

/**
 * Читает artifact `metrics.json` прогона через MLflow REST.
 *
 * Возвращает `null` при любой ошибке (E4): страница переходит на разбор
 * ключей метрик. Формат — `{run_id, metrics, by_channel: {channel: {n_samples, metrics}}}`.
 */
export const fetchMetricsJson = async (runId: string): Promise<any | null> => {
  if (!runId) {
    return null;
  }
  try {
    const response = await fetch(
      `/get-artifact?run_uuid=${encodeURIComponent(runId)}&path=metrics.json`,
    );
    if (!response.ok) {
      return null;
    }
    const text = await response.text();
    if (!text.trim()) {
      return null;
    }
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** Преобразует `by_channel` из `metrics.json` в структуру страницы. */
export const channelsFromReport = (report: any): ZalaChannel[] => {
  const byChannel = report?.by_channel;
  if (!byChannel || typeof byChannel !== 'object') {
    return [];
  }
  return Object.entries(byChannel as Record<string, any>)
    .map(([channel, payload]) => {
      const rawMetrics = Array.isArray(payload?.metrics) ? payload.metrics : [];
      const metrics = rawMetrics.map((metric: any): ZalaChannelMetric => {
        const ci = Array.isArray(metric?.ci) ? metric.ci : [];
        return {
          name: String(metric?.name ?? '—'),
          value: typeof metric?.value === 'number' ? metric.value : null,
          ciLower: typeof ci[0] === 'number' ? ci[0] : null,
          ciUpper: typeof ci[1] === 'number' ? ci[1] : null,
          status: String(metric?.status ?? 'ok'),
        };
      });
      return {
        channel,
        metrics: metrics.sort((a: ZalaChannelMetric, b: ZalaChannelMetric) => a.name.localeCompare(b.name)),
        nSamples: typeof payload?.n_samples === 'number' ? payload.n_samples : undefined,
      };
    })
    .filter((entry) => entry.metrics.length > 0)
    .sort((a, b) => a.channel.localeCompare(b.channel));
};

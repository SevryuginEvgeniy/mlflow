/**
 * ZALABench — вкладка лидерборда (Ф6, K8).
 *
 * Три подэкрана: рейтинг по BT (главный), матрица «кандидат × датасет»,
 * матрица судей N×N. Числа рейтинга — из рана эксперимента `zala-rating`
 * (метрики `zala.rating.*`), матрица значений — из обычных прогонов
 * (`zala.metric.*`), кандидаты — из `zalabench-api` (`/candidates`).
 *
 * Ничего не считает сам: рейтинг считается ночным прогоном (FR-015),
 * страница только показывает и позволяет вести список кандидатов.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Empty,
  Input,
  Modal,
  SimpleSelect,
  SimpleSelectOption,
  Spinner,
  Table,
  TableCell,
  TableHeader,
  TableRow,
  Tag,
  Typography,
  useDesignSystemTheme,
} from '@databricks/design-system';

import type { ZalaRunSummary } from './api';
import { normalizeModelName, readStamp, searchZalaRuns } from './api';
import { ZalaApiError, getApiBase, listExperiments } from './jobsApi';

/** Эксперимент, в ран которого публикуется рейтинг (metrics/rating.py). */
const RATING_EXPERIMENT = 'zala-rating';
/** Префикс метрик рейтинга. */
const RATING_PREFIX = 'zala.rating.';
/** Метрики, доступные на подэкране матрицы (FR-015, список фиксирован). */
const MATRIX_METRICS = [
  'judge_score',
  'scorer_accuracy',
  'exact_match',
  'pass_at_k',
  'cost_per_solved_task',
  'tool_call_accuracy',
] as const;
/** Порог, ниже которого ячейка помечается «недостаточно данных» (FR-015). */
const MIN_N = 5;
/** Сколько кандидатов показывать до «показать все». */
const TOP_N = 10;
/** Свежие неоценённые кандидаты видны всегда (дней). */
const FRESH_DAYS = 7;
/** Ключ токена API в localStorage (как в JobsPage). */
const TOKEN_STORAGE_KEY = 'zala.apiToken';

type Screen = 'rating' | 'matrix' | 'judges';
type Aggregate = 'median' | 'mean';

/** Кандидат из `/candidates` (CandidateOut). */
interface Candidate {
  id: string;
  displayName: string;
  config: Record<string, unknown>;
  signatureHash: string;
  isService: boolean;
}

/** Строка рейтинга, разобранная из метрик рана `zala-rating`. */
interface RatingRow {
  candidateId: string;
  value: number | undefined;
  ciLower: number | undefined;
  ciUpper: number | undefined;
  /** Сколько прогонов вошло в расчёт (теги `zala.matrix.run.<кандидат>`). */
  runs: number | undefined;
  /** Сколько судей дали оценку (метрика `judges.<кандидат>`). */
  judges: number | undefined;
  selfPreference: number | undefined;
}

/** Ячейка матрицы «кандидат × датасет». */
interface MatrixCell {
  value: number | undefined;
  n: number | undefined;
  insufficient: boolean;
  ci: string | undefined;
}

interface JudgeMatrix {
  judges: string[];
  models: string[];
  /** `cell[model][judge]`; диагональ — самооценка. */
  cell: Record<string, Record<string, number>>;
}

const readToken = (): string => {
  try {
    // eslint-disable-next-line @databricks/no-direct-storage -- токен вне React, как в JobsPage
    return localStorage.getItem(TOKEN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
};

/** Компактный вывод числа; строки и null терпит (`NaN` из API — прочерк). */
const formatNumber = (value: number | string | null | undefined): string => {
  const numeric = typeof value === 'string' ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) {
    return '—';
  }
  return String(Number(numeric.toFixed(3)));
};

/** Метрика рейтинга — `number | undefined` (п.107: `NaN` приходит строкой). */
const toNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

/**
 * Разбор рана рейтинга.
 *
 * Реальные ключи (metrics/rating.py, scripts/run_matrix.py):
 * `zala.rating.<кандидат>` — сила, `.<кандидат>.ci_low|ci_high` — CI,
 * `n.<кандидат>` — сколько судей дали оценку, `mean.<кандидат>` — среднее,
 * `self_preference.<кандидат>` — Δ судьи по своей строке,
 * `self_preference.delta` — общий Δ. Число прогонов — теги
 * `zala.matrix.run.<кандидат>`.
 */
const parseRatingMetrics = (
  metrics: Record<string, number>,
  tags: Record<string, string>,
): { rows: RatingRow[]; selfPreferenceDelta: number | undefined } => {
  const rows = new Map<string, RatingRow>();
  const row = (id: string): RatingRow => {
    const existing = rows.get(id);
    if (existing) {
      return existing;
    }
    const created: RatingRow = {
      candidateId: id,
      value: undefined,
      ciLower: undefined,
      ciUpper: undefined,
      runs: undefined,
      judges: undefined,
      selfPreference: undefined,
    };
    rows.set(id, created);
    return created;
  };
  Object.entries(metrics).forEach(([key, raw]) => {
    if (!key.startsWith(RATING_PREFIX)) {
      return;
    }
    const rest = key.slice(RATING_PREFIX.length);
    if (!rest || rest.startsWith('matrix.') || rest.startsWith('judge.')) {
      return;
    }
    const value = toNumber(raw);
    if (value === undefined) {
      return;
    }
    // `self_preference.delta` — общий Δ, не кандидат.
    if (rest === 'self_preference.delta') {
      return;
    }
    const parts = rest.split('.');
    if (parts.length === 1) {
      row(parts[0]).value = value;
      return;
    }
    const [head, tail] = parts;
    if (head === 'judges' || head === 'n') {
      row(tail).judges = value;
    } else if (head === 'self_preference') {
      row(tail).selfPreference = value; // per-judge, не на кандидата
    } else if (head === 'mean') {
      // справочное среднее — в колонке рейтинга не показываем
    } else if (tail === 'ci_low' || tail === 'ci_lower') {
      row(head).ciLower = value;
    } else if (tail === 'ci_high' || tail === 'ci_upper') {
      row(head).ciUpper = value;
    }
  });

  // Прогонов в расчёте — по тегам `zala.matrix.run.<кандидат>`.
  const runCounts = new Map<string, number>();
  Object.keys(tags).forEach((key) => {
    if (!key.startsWith('zala.matrix.run.')) {
      return;
    }
    const id = key.slice('zala.matrix.run.'.length);
    runCounts.set(id, (runCounts.get(id) ?? 0) + 1);
  });
  runCounts.forEach((count, id) => {
    row(id).runs = count;
  });

  const delta = toNumber(metrics[`${RATING_PREFIX}self_preference.delta`]);
  return { rows: [...rows.values()].filter((entry) => entry.value !== undefined), selfPreferenceDelta: delta };
};

/** Медиана набора (пустой набор — `undefined`). */
const median = (values: number[]): number | undefined => {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

const mean = (values: number[]): number | undefined =>
  values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * Матрица судей N×N.
 *
 * Ячейки в метрики не публикуются — они лежат в артефакте
 * `judge_calls.jsonl` прогона каждого кандидата (scripts/run_matrix.py,
 * `accumulate`). Ран рейтинга даёт только теги `zala.matrix.run.<кандидат>`
 * (-> run_id), `zala.matrix.models` и `zala.matrix.judges`.
 *
 * `model` в вызове — это СУДЬЯ, кандидат берётся из прогона, чей артефакт
 * читается. Значение — медиана по сэмплам, как в скрипте.
 */
const loadJudgeMatrix = async (ratingRun: ZalaRunSummary): Promise<JudgeMatrix> => {
  const runByModel = new Map<string, string>();
  Object.entries(ratingRun.tags).forEach(([key, value]) => {
    if (key.startsWith('zala.matrix.run.')) {
      runByModel.set(key.slice('zala.matrix.run.'.length), value);
    }
  });
  const judges = (ratingRun.tags['zala.matrix.judges'] ?? '').split(',').filter(Boolean);
  if (runByModel.size === 0 || judges.length === 0) {
    return { judges: [], models: [], cell: {} };
  }
  const cell: Record<string, Record<string, number>> = {};
  await Promise.all(
    [...runByModel.entries()].map(async ([candidate, runId]) => {
      // Артефакты отдаёт MLflow (тот же origin), а не zalabench-api.
      const response = await fetch(
        `/get-artifact?run_uuid=${encodeURIComponent(runId)}&path=judge_calls.jsonl`,
      );
      if (!response.ok) {
        return;
      }
      const text = await response.text();
      const scores = new Map<string, number[]>();
      text.split('\n').forEach((line) => {
        if (!line.trim()) {
          return;
        }
        try {
          const call = JSON.parse(line) as {
            kind?: string;
            model?: string;
            verdict?: { score?: unknown };
          };
          if (call.kind !== 'single') {
            return;
          }
          const judge = normalizeModelName(call.model);
          const score = toNumber(call.verdict?.score);
          if (!judge || score === undefined) {
            return;
          }
          const bucket = scores.get(judge) ?? [];
          bucket.push(score);
          scores.set(judge, bucket);
        } catch {
          // битая строка аудита не ломает матрицу
        }
      });
      scores.forEach((values, judge) => {
        const value = median(values);
        if (value !== undefined) {
          cell[candidate] = cell[candidate] ?? {};
          cell[candidate][judge] = value;
        }
      });
    }),
  );
  const models = (ratingRun.tags['zala.matrix.models'] ?? '').split(',').filter(Boolean);
  // Столбцы — только судьи, у которых есть вызовы (иначе пустые колонки).
  const used = new Set(Object.values(cell).flatMap((row) => Object.keys(row)));
  return { judges: judges.filter((judge) => used.has(judge)), models, cell };
};

/** Конфиг прогона из `metadata` параметра (для сопоставления с кандидатом). */
const runConfig = (run: ZalaRunSummary): Record<string, unknown> => {
  const raw = run.params?.['metadata'];
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as { zala_run_config?: Record<string, unknown> };
    return parsed.zala_run_config ?? {};
  } catch {
    return {};
  }
};

/** Совпадает ли прогон с кандидатом по модели/квантизации/температуре. */
const runMatchesCandidate = (run: ZalaRunSummary, candidate: Candidate): boolean => {
  const config = runConfig(run);
  const model = normalizeModelName(String(config['model'] ?? run.model)).split('/').pop()?.toLowerCase();
  const candidateModel = normalizeModelName(String(candidate.config['model'] ?? ''))
    .split('/')
    .pop()
    ?.toLowerCase();
  if (!model || !candidateModel || model !== candidateModel) {
    return false;
  }
  const runKnobs = (config['knobs'] ?? {}) as Record<string, unknown>;
  const candidateKnobs = (candidate.config['knobs'] ?? {}) as Record<string, unknown>;
  const runTemperature = toNumber(runKnobs['temperature']);
  const candidateTemperature = toNumber(candidateKnobs['temperature']);
  if (runTemperature !== undefined && candidateTemperature !== undefined && runTemperature !== candidateTemperature) {
    return false;
  }
  const runQuantization = String(config['quantization'] ?? 'none');
  const candidateQuantization = String(candidate.config['quantization'] ?? 'none');
  return runQuantization === candidateQuantization;
};

const fetchCandidates = async (token: string): Promise<Candidate[]> => {
  const response = await fetch(`${getApiBase()}/candidates`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const payload = await response.json();
      if (typeof payload?.detail === 'string') {
        detail = payload.detail;
      }
    } catch {
      // тело не JSON — оставляем код
    }
    throw new ZalaApiError(detail, response.status);
  }
  const payload = (await response.json()) as { candidates?: Array<Record<string, unknown>> };
  return (payload.candidates ?? []).map((item) => ({
    id: String(item['id'] ?? ''),
    displayName: String(item['display_name'] ?? item['id'] ?? ''),
    config: (item['config'] ?? {}) as Record<string, unknown>,
    signatureHash: String(item['signature_hash'] ?? ''),
    isService: Boolean(item['is_service']),
  }));
};

export const LeaderboardPage = (): JSX.Element => {
  const { theme } = useDesignSystemTheme();
  const token = useMemo(readToken, []);

  const [screen, setScreen] = useState<Screen>('rating');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [experiments, setExperiments] = useState<Array<{ name: string; experimentId: string }>>([]);
  const [experiment, setExperiment] = useState<string>('');
  const [periodDays, setPeriodDays] = useState<string>('all');
  const [datasetFilter, setDatasetFilter] = useState<string>('');
  const [matrixMetric, setMatrixMetric] = useState<string>(MATRIX_METRICS[0]);
  const [aggregate, setAggregate] = useState<Aggregate>('median');
  const [showAll, setShowAll] = useState(false);

  const [ratingRows, setRatingRows] = useState<RatingRow[]>([]);
  const [selfPreferenceDelta, setSelfPreferenceDelta] = useState<number | undefined>(undefined);
  const [judgeMatrix, setJudgeMatrix] = useState<JudgeMatrix>({ judges: [], models: [], cell: {} });
  const [runs, setRuns] = useState<ZalaRunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [addModel, setAddModel] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [addSaving, setAddSaving] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [candidateList, experimentList] = await Promise.all([
        fetchCandidates(token),
        listExperiments().catch(() => []),
      ]);
      setCandidates(candidateList);
      setExperiments(experimentList);

      // Выбранный эксперимент — строгий фильтр: ран рейтинга лежит в своём
      // эксперименте и при явном выборе в выборку не подмешивается.
      const ratingId = experimentList.find((item) => item.name === RATING_EXPERIMENT)?.experimentId;
      const experimentIds = experiment
        ? [experiment]
        : experimentList.map((item) => item.experimentId);
      const ids = !experiment && ratingId ? [...new Set([...experimentIds, ratingId])] : experimentIds;

      if (ids.length === 0) {
        setRuns([]);
        setRatingRows([]);
        setJudgeMatrix({ judges: [], models: [], cell: {} });
        return;
      }

      const page = await searchZalaRuns(ids, { limit: 200 });
      const since = periodDays === 'all' ? 0 : Date.now() - Number(periodDays) * 86_400_000;
      const inPeriod = page.runs.filter((run) => run.startTime >= since);
      setRuns(inPeriod);

      const ratingRuns = inPeriod
        .filter((run) => run.experimentId === ratingId)
        .sort((a, b) => b.startTime - a.startTime);
      const latest = ratingRuns[0];
      if (latest) {
        const parsed = parseRatingMetrics(latest.metrics, latest.tags);
        setRatingRows(parsed.rows);
        setSelfPreferenceDelta(parsed.selfPreferenceDelta);
        setJudgeMatrix(await loadJudgeMatrix(latest));
      } else {
        setRatingRows([]);
        setSelfPreferenceDelta(undefined);
        setJudgeMatrix({ judges: [], models: [], cell: {} });
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [experiment, periodDays, token]);

  useEffect(() => {
    void load();
  }, [load]);

  const workRuns = useMemo(
    () => runs.filter((run) => !run.tags['zala.rating'] && !run.tags['zala.rating.run']),
    [runs],
  );

  const candidateById = useMemo(
    () => new Map(candidates.map((candidate) => [candidate.id, candidate])),
    [candidates],
  );

  const labelFor = useCallback(
    (candidateId: string): string => {
      const candidate = candidateById.get(candidateId);
      if (candidate) {
        return candidate.displayName;
      }
      // В рейтинге ключ метрики — имя модели, а id кандидата — хэш подписи.
      const byModel = candidates.find(
        (item) => normalizeModelName(String(item.config['model'] ?? '')).toLowerCase() === candidateId.toLowerCase(),
      );
      return byModel ? byModel.displayName : candidateId;
    },
    [candidateById, candidates],
  );

  /** Строки рейтинга с учётом топ-N и свежих неоценённых кандидатов. */
  const visibleRatingRows = useMemo(() => {
    const rated = [...ratingRows].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    if (showAll) {
      return rated;
    }
    const ratedModels = new Set(ratingRows.map((row) => row.candidateId.toLowerCase()));
    const fresh = candidates.filter((candidate) => {
      const model = normalizeModelName(String(candidate.config['model'] ?? '')).toLowerCase();
      return !ratedModels.has(model);
    });
    const sliced = rated.slice(0, TOP_N);
    const slicedIds = new Set(sliced.map((row) => row.candidateId));
    fresh.forEach((candidate) => {
      if (!slicedIds.has(candidate.id)) {
        sliced.push({ candidateId: candidate.id, value: undefined, ciLower: undefined, ciUpper: undefined, runs: undefined, judges: undefined, selfPreference: undefined });
      }
    });
    return sliced;
  }, [candidates, ratingRows, showAll]);

  // Колонка Δ — только когда матрица дала хоть одну оценку самооценки.
  const hasSelfPreference = ratingRows.some((row) => row.selfPreference !== undefined);

  /** Перекрытие CI → метка «≈» (интервалы несравнимы). */
  const overlaps = (row: RatingRow, other: RatingRow): boolean =>
    row.ciLower !== undefined &&
    row.ciUpper !== undefined &&
    other.ciLower !== undefined &&
    other.ciUpper !== undefined &&
    row.ciLower <= other.ciUpper &&
    other.ciLower <= row.ciUpper;

  const stampSets = useMemo(() => {
    const sets = new Set(workRuns.map((run) => readStamp(run.tags).dataset + readStamp(run.tags).judge));
    return sets.size;
  }, [workRuns]);

  /**
   * Матрица «кандидат × датасет» из прогонов.
   *
   * Строки — уникальные имена кандидатов (в реестре один и тот же алиас
   * заведён под разные датасеты/эксперименты), столбцы — датасеты из данных.
   */
  const matrix = useMemo(() => {
    const rowsData = [
      ...new Map(
        candidates.filter((item) => !item.isService).map((item) => [item.displayName, item]),
      ).values(),
    ];
    const datasets = [...new Set(workRuns.map((run) => run.dataset))].filter((name) => name && name !== '—').sort();
    const cell: Record<string, Record<string, MatrixCell>> = {};
    rowsData.forEach((candidate) => {
      const sameName = candidates.filter((item) => item.displayName === candidate.displayName);
      const rowRuns = workRuns.filter((run) => sameName.some((item) => runMatchesCandidate(run, item)));
      const rowCell: Record<string, MatrixCell> = {};
      datasets.forEach((dataset) => {
        const matching = rowRuns.filter((run) => run.dataset === dataset);
        if (matching.length === 0) {
          rowCell[dataset] = { value: undefined, n: undefined, insufficient: false, ci: undefined };
          return;
        }
        const latest = matching.sort((a, b) => b.startTime - a.startTime)[0];
        const key = `zala.metric.${matrixMetric}`;
        const n = toNumber(latest.tags[`${key}.n`]);
        const status = latest.tags[`${key}.status`] ?? 'ok';
        const value = toNumber(latest.metrics[key]);
        const low = toNumber(latest.metrics[`${key}.ci_lower`]);
        const high = toNumber(latest.metrics[`${key}.ci_upper`]);
        rowCell[dataset] = {
          value,
          n,
          // NaN-значение в MLflow не пишется вовсе — это тоже «нет данных».
          // Нет `n` — доказать ≥5 нельзя, считаем недостаточным (FR-015).
          insufficient: status === 'insufficient_data' || n === undefined || n < MIN_N,
          ci: low !== undefined && high !== undefined ? `[${formatNumber(low)}…${formatNumber(high)}]` : undefined,
        };
      });
      cell[candidate.displayName] = rowCell;
    });
    return { datasets, cell, rows: rowsData };
  }, [candidates, matrixMetric, workRuns]);

  const filteredMatrix = useMemo(() => {
    const datasets = datasetFilter
      ? matrix.datasets.filter((dataset) => dataset === datasetFilter)
      : matrix.datasets;
    return { ...matrix, datasets };
  }, [datasetFilter, matrix]);

  // Строки — модели-кандидаты, столбцы — судьи (из тегов рана рейтинга).
  const judgeModels = useMemo(
    () => [...new Set([...judgeMatrix.models, ...Object.keys(judgeMatrix.cell)])],
    [judgeMatrix],
  );

  const consensus = useCallback(
    (model: string): number | undefined => {
      const values = judgeMatrix.judges
        .map((judge) => judgeMatrix.cell[model]?.[judge])
        .filter((value): value is number => value !== undefined);
      return aggregate === 'median' ? median(values) : mean(values);
    },
    [aggregate, judgeMatrix],
  );

  const allCellsInsufficient = useMemo(() => {
    const cells = Object.values(filteredMatrix.cell).flatMap((row) => Object.values(row));
    const filled = cells.filter((cell) => cell.value !== undefined);
    return filled.length > 0 && filled.every((cell) => cell.insufficient);
  }, [filteredMatrix]);

  const submitCandidate = async () => {
    setAddError(null);
    if (!addName.trim() || !addModel.trim()) {
      setAddError('Нужны имя и модель');
      return;
    }
    setAddSaving(true);
    try {
      const response = await fetch(`${getApiBase()}/candidates`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          display_name: addName.trim(),
          config: { model: addModel.trim(), knobs: {}, quantization: 'none' },
        }),
      });
      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
          const payload = await response.json();
          if (typeof payload?.detail === 'string') {
            detail = payload.detail;
          }
        } catch {
          // тело не JSON
        }
        throw new ZalaApiError(detail, response.status);
      }
      setAddOpen(false);
      setAddName('');
      setAddModel('');
      await load();
    } catch (error) {
      setAddError(error instanceof Error ? error.message : String(error));
    } finally {
      setAddSaving(false);
    }
  };

  const submitRename = async (candidateId: string) => {
    if (!renameValue.trim()) {
      return;
    }
    try {
      const response = await fetch(`${getApiBase()}/candidates/${encodeURIComponent(candidateId)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ display_name: renameValue.trim() }),
      });
      if (!response.ok) {
        throw new ZalaApiError(`HTTP ${response.status}`, response.status);
      }
      setRenamingId(null);
      await load();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  };

  const renderEmptyState = (): JSX.Element | null => {
    if (loading) {
      return null;
    }
    if (ratingRows.length === 0 && workRuns.length === 0) {
      return (
        <Empty
          title="Рейтинг появится после первого прогона с судейством"
          description={
            <Button componentId="zala.leaderboard.empty.jobs" onClick={() => { window.location.hash = '#/zala/jobs'; }}>
              Поставить задачу →
            </Button>
          }
        />
      );
    }
    if (ratingRows.length === 0) {
      return (
        <Alert
          type="info"
          componentId="zala.leaderboard.empty.pairwise"
          message={
            screen === 'rating'
              ? 'Рейтинг требует попарных сравнений. Показываем матрицу по одиночным оценкам.'
              : 'Попарных сравнений нет — матрица построена по одиночным оценкам.'
          }
          description={
            <Button componentId="zala.leaderboard.empty.jobs2" onClick={() => { window.location.hash = '#/zala/jobs'; }}>
              Как запустить pairwise →
            </Button>
          }
        />
      );
    }
    if (allCellsInsufficient) {
      return (
        <Alert
          type="warning"
          componentId="zala.leaderboard.empty.n"
          message={`Недостаточно данных: нужно ≥${MIN_N} сэмплов на ячейку (FR-015)`}
        />
      );
    }
    return null;
  };

  const renderRating = (): JSX.Element => {
    if (ratingRows.length === 0) {
      return renderEmptyState() ?? <Spinner />;
    }
    return (
      <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.sm }}>
      {selfPreferenceDelta !== undefined && (
        <Typography.Text size="sm" css={{ color: theme.colors.textSecondary }}>
          Δ самопредпочтения по матрице целиком (медиана диагонали − медиана чужих оценок):{' '}
          {formatNumber(selfPreferenceDelta)}
        </Typography.Text>
      )}
      <Table scrollable noMinHeight>
        <TableRow isHeader>
          <TableHeader componentId="zala.leaderboard.rank_header" css={{ flex: 0.4 }}>
            #
          </TableHeader>
          <TableHeader componentId="zala.leaderboard.candidate_header" css={{ flex: 2.4 }}>
            Кандидат
          </TableHeader>
          <TableHeader componentId="zala.leaderboard.rating_header" css={{ flex: 0.8 }}>
            Рейтинг
          </TableHeader>
          <TableHeader componentId="zala.leaderboard.ci_header" css={{ flex: 1.4 }}>
            CI
          </TableHeader>
          {hasSelfPreference && (
            <TableHeader componentId="zala.leaderboard.self_pref_header" css={{ flex: 1.2 }}>
              Δ самопредпочтения
            </TableHeader>
          )}
          <TableHeader componentId="zala.leaderboard.runs_header" css={{ flex: 0.8 }}>
            Прогонов
          </TableHeader>
        </TableRow>
          {visibleRatingRows.map((row, index) => {
            const candidate = candidateById.get(row.candidateId);
            const config = candidate?.config ?? {};
            const approximate = ratingRows.some((other) => other !== row && overlaps(row, other));
            return (
              <TableRow key={row.candidateId}>
                <TableCell css={{ flex: 0.4 }}>{row.value === undefined ? '—' : index + 1}</TableCell>
                <TableCell css={{ flex: 2.4 }}>
                  {renamingId === row.candidateId ? (
                    <div css={{ display: 'flex', gap: theme.spacing.xs }}>
                      <Input
                        componentId="zala.leaderboard.rename"
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                      />
                      <Button componentId="zala.leaderboard.rename.save" onClick={() => void submitRename(row.candidateId)}>
                        ОК
                      </Button>
                      <Button componentId="zala.leaderboard.rename.cancel" onClick={() => setRenamingId(null)}>
                        Отмена
                      </Button>
                    </div>
                  ) : (
                    <div
                      title={`${JSON.stringify(config, null, 2)}${candidate ? '' : '\n(кандидата нет в списке)'}`}
                      css={{ display: 'flex', alignItems: 'center', gap: theme.spacing.xs }}
                    >
                      <span>{labelFor(row.candidateId)}</span>
                      {candidate && (
                        <Button
                          componentId="zala.leaderboard.rename.open"
                          onClick={() => {
                            setRenamingId(row.candidateId);
                            setRenameValue(candidate.displayName);
                          }}
                        >
                          Переименовать
                        </Button>
                      )}
                    </div>
                  )}
                </TableCell>
                <TableCell css={{ flex: 0.8 }}>{row.value === undefined ? <span css={{ color: theme.colors.textSecondary }}>—</span> : formatNumber(row.value)}</TableCell>
                <TableCell css={{ flex: 1.4 }}>
                  {row.ciLower === undefined || row.ciUpper === undefined
                    ? '—'
                    : `${approximate ? '≈ ' : ''}[${formatNumber(row.ciLower)}…${formatNumber(row.ciUpper)}]`}
                </TableCell>
                {hasSelfPreference && (
                  <TableCell css={{ flex: 1.2 }}>{formatNumber(row.selfPreference)}</TableCell>
                )}
                <TableCell css={{ flex: 0.8 }}>{formatNumber(row.runs)}</TableCell>
              </TableRow>
            );
          })}
      </Table>
      </div>
    );
  };

  const renderMatrix = (): JSX.Element => {
    const notice = ratingRows.length === 0 || allCellsInsufficient ? renderEmptyState() : null;
    if (filteredMatrix.datasets.length === 0) {
      return (
        <>
          {notice}
          <Empty title="Нет данных для матрицы" description="Нужны прогоны с метриками по датасетам." />
        </>
      );
    }
    return (
      <>
      {notice}
      <div css={{ overflowX: 'auto' }}>
        <Table scrollable noMinHeight>
          <TableRow isHeader>
            <TableHeader componentId="zala.leaderboard.matrix_header" css={{ flex: 1.8 }}>
              Кандидат
            </TableHeader>
            {filteredMatrix.datasets.map((dataset) => (
              <TableHeader key={dataset} componentId="zala.leaderboard.matrix_dataset_header" css={{ flex: 1 }}>
                {dataset}
              </TableHeader>
            ))}
          </TableRow>
            {filteredMatrix.rows.map((candidate) => (
              <TableRow key={candidate.displayName}>
                <TableCell css={{ flex: 1.8 }}>{candidate.displayName}</TableCell>
                {filteredMatrix.datasets.map((dataset) => {
                  const cell = filteredMatrix.cell[candidate.displayName]?.[dataset];
                  if (!cell || cell.value === undefined) {
                    return (
                      <TableCell key={dataset} css={{ flex: 1 }}>
                        <span css={{ color: theme.colors.textSecondary, opacity: cell?.insufficient ? 0.55 : 1 }}>
                          —{cell?.insufficient && cell.n !== undefined ? ` n=${cell.n}` : ''}
                        </span>
                      </TableCell>
                    );
                  }
                  return (
                    <TableCell key={dataset} css={{ flex: 1 }} title={cell.ci ? `CI ${cell.ci}${cell.n !== undefined ? ` · n=${cell.n}` : ''}` : undefined}>
                      <span css={{ opacity: cell.insufficient ? 0.55 : 1 }}>
                        {formatNumber(cell.value)}
                        {cell.insufficient && cell.n !== undefined && (
                          <Tag componentId="zala.leaderboard.insufficient" css={{ marginLeft: theme.spacing.xs }}>
                            n={cell.n}
                          </Tag>
                        )}
                      </span>
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </Table>
      </div>
      </>
    );
  };

  const renderJudges = (): JSX.Element => {
    const notice = ratingRows.length === 0 ? renderEmptyState() : null;
    if (judgeModels.length === 0) {
      return (
        <>
          {notice}
          <Empty title="Матрица судей не посчитана" description="Нужен прогон рейтинга с матрицей судей." />
        </>
      );
    }
    return (
      <>
      {notice}
      <div css={{ overflowX: 'auto' }}>
        <Table scrollable noMinHeight>
          <TableRow isHeader>
            <TableHeader componentId="zala.leaderboard.judges_header" css={{ flex: 1.8 }}>
              Модель \ Судья
            </TableHeader>
            {judgeMatrix.judges.map((judge) => (
              <TableHeader key={judge} componentId="zala.leaderboard.judge_header" css={{ flex: 1 }}>
                {judge}
              </TableHeader>
            ))}
            <TableHeader componentId="zala.leaderboard.consensus_header" css={{ flex: 1 }}>
              Консенсус
            </TableHeader>
          </TableRow>
            {judgeModels.map((model) => (
              <TableRow key={model}>
                <TableCell css={{ flex: 1.8 }}>{labelFor(model)}</TableCell>
                {judgeMatrix.judges.map((judge) => {
                  const value = judgeMatrix.cell[model]?.[judge];
                  const diagonal = normalizeModelName(model) === normalizeModelName(judge);
                  return (
                    <TableCell
                      key={judge}
                      css={{
                        flex: 1,
                        ...(diagonal
                          ? { background: theme.colors.backgroundSecondary, fontWeight: theme.typography.typographyBoldFontWeight }
                          : {}),
                      }}
                    >
                      {formatNumber(value)}
                    </TableCell>
                  );
                })}
                <TableCell css={{ flex: 1, fontWeight: theme.typography.typographyBoldFontWeight }}>{formatNumber(consensus(model))}</TableCell>
              </TableRow>
            ))}
          </Table>
      </div>
      </>
    );
  };

  return (
    <div css={{ padding: theme.spacing.lg, display: 'flex', flexDirection: 'column', gap: theme.spacing.md }}>
      <div css={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: theme.spacing.md, flexWrap: 'wrap' }}>
        <Typography.Title level={2} css={{ marginBottom: 0 }}>
          Лидерборд
        </Typography.Title>
        <div css={{ display: 'flex', gap: theme.spacing.sm }}>
          <Button componentId="zala.leaderboard.add" onClick={() => setAddOpen(true)}>
            + Добавить кандидата
          </Button>
          <Button componentId="zala.leaderboard.export" onClick={() => { window.location.href = `${getApiBase()}/candidates/export.yaml`; }}>
            Экспорт YAML
          </Button>
        </div>
      </div>

      <div css={{ display: 'flex', gap: theme.spacing.sm, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div>
          <Typography.Text size="sm">Экран</Typography.Text>
          <div css={{ display: 'flex', gap: theme.spacing.xs }}>
            <Button componentId="zala.leaderboard.screen.rating" onClick={() => setScreen('rating')} type={screen === 'rating' ? 'primary' : 'tertiary'}>
              Рейтинг
            </Button>
            <Button componentId="zala.leaderboard.screen.matrix" onClick={() => setScreen('matrix')} type={screen === 'matrix' ? 'primary' : 'tertiary'}>
              Матрица кандидат × датасет
            </Button>
            <Button componentId="zala.leaderboard.screen.judges" onClick={() => setScreen('judges')} type={screen === 'judges' ? 'primary' : 'tertiary'}>
              Матрица судей
            </Button>
          </div>
        </div>
        <div>
          <Typography.Text size="sm">Эксперимент</Typography.Text>
          <SimpleSelect
            id="zala-leaderboard-experiment"
            componentId="zala.leaderboard.filter.experiment"
            value={experiment}
            onChange={({ target }) => setExperiment(target.value ?? '')}
          >
            <SimpleSelectOption value="">Все</SimpleSelectOption>
            {experiments.map((item) => (
              <SimpleSelectOption key={item.experimentId} value={item.experimentId}>
                {item.name}
              </SimpleSelectOption>
            ))}
          </SimpleSelect>
        </div>
        <div>
          <Typography.Text size="sm">Период</Typography.Text>
          <SimpleSelect
            id="zala-leaderboard-period"
            componentId="zala.leaderboard.filter.period"
            value={periodDays}
            onChange={({ target }) => setPeriodDays(target.value ?? 'all')}
          >
            <SimpleSelectOption value="all">Весь период</SimpleSelectOption>
            <SimpleSelectOption value="7">7 дней</SimpleSelectOption>
            <SimpleSelectOption value="30">30 дней</SimpleSelectOption>
          </SimpleSelect>
        </div>
        {screen === 'matrix' && (
          <>
            <div>
              <Typography.Text size="sm">Датасет</Typography.Text>
              <SimpleSelect
                id="zala-leaderboard-dataset"
            componentId="zala.leaderboard.filter.dataset"
                value={datasetFilter}
                onChange={({ target }) => setDatasetFilter(target.value ?? '')}
              >
                <SimpleSelectOption value="">Все</SimpleSelectOption>
                {matrix.datasets.map((dataset) => (
                  <SimpleSelectOption key={dataset} value={dataset}>
                    {dataset}
                  </SimpleSelectOption>
                ))}
              </SimpleSelect>
            </div>
            <div>
              <Typography.Text size="sm">Метрика</Typography.Text>
              <SimpleSelect
                id="zala-leaderboard-metric"
            componentId="zala.leaderboard.filter.metric"
                value={matrixMetric}
                onChange={({ target }) => setMatrixMetric(target.value ?? MATRIX_METRICS[0])}
              >
                {MATRIX_METRICS.map((metric) => (
                  <SimpleSelectOption key={metric} value={metric}>
                    {metric}
                  </SimpleSelectOption>
                ))}
              </SimpleSelect>
            </div>
          </>
        )}
        {screen === 'judges' && (
          <div>
            <Typography.Text size="sm">Сводка</Typography.Text>
            <SimpleSelect
              id="zala-leaderboard-aggregate"
            componentId="zala.leaderboard.filter.aggregate"
              value={aggregate}
              onChange={({ target }) => setAggregate((target.value as Aggregate) ?? 'median')}
            >
              <SimpleSelectOption value="median">Медиана</SimpleSelectOption>
              <SimpleSelectOption value="mean">Среднее</SimpleSelectOption>
            </SimpleSelect>
          </div>
        )}
        <Button componentId="zala.leaderboard.reload" onClick={() => void load()}>
          Обновить
        </Button>
      </div>

      {loadError && <Alert type="error" componentId="zala.leaderboard.error" message={loadError} />}

      {!loading && stampSets > 1 && (
        <Alert
          type="warning"
          componentId="zala.leaderboard.stamps"
          message={`В расчёт вошли прогоны с ${stampSets} разными наборами штампов — числа могут быть несравнимы`}
        />
      )}

      {loading ? <Spinner /> : screen === 'rating' ? renderRating() : screen === 'matrix' ? renderMatrix() : renderJudges()}

      {screen === 'rating' && ratingRows.length > TOP_N && (
        <div>
          <Button componentId="zala.leaderboard.show_all" onClick={() => setShowAll((value) => !value)}>
            {showAll ? 'Показать топ' : 'Показать все'}
          </Button>
        </div>
      )}

      <Modal
        componentId="zala.leaderboard.add.modal"
        title="Новый кандидат"
        visible={addOpen}
        onCancel={() => setAddOpen(false)}
        onOk={() => void submitCandidate()}
        okText="Добавить"
        okButtonProps={{ loading: addSaving }}
        cancelText="Отмена"
      >
        <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.sm }}>
          <Typography.Text>Имя кандидата</Typography.Text>
          <Input componentId="zala.leaderboard.add.name" value={addName} onChange={(event) => setAddName(event.target.value)} />
          <Typography.Text>Модель (алиас кластера)</Typography.Text>
          <Input componentId="zala.leaderboard.add.model" value={addModel} onChange={(event) => setAddModel(event.target.value)} />
          {addError && <Alert type="error" componentId="zala.leaderboard.add.error" message={addError} />}
        </div>
      </Modal>
    </div>
  );
};

export default LeaderboardPage;

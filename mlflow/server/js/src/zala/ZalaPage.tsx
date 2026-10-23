/**
 * ZALABench — обзорная вкладка (Ф3.7, переработана в Ф4.3).
 *
 * Один экран: слева таблица прогонов эксперимента (с фильтрами и поиском),
 * справа детали выбранного прогона (статические и судейские метрики,
 * разбивка по каналам, вердикты по сэмплам, сравнение с вторым прогоном
 * и маркировка несравнимости по штампам N-X). Данные — MLflow REST напрямую
 * (read-only).
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
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

import { useSearchParams } from '../common/utils/RoutingUtils';
import type { ZalaGroup } from './jobsApi';
import { ZalaApiError, createJudgeJob, getGroup, listExperiments, listModels } from './jobsApi';
import type { ZalaChannel, ZalaRunSummary, ZalaTrace } from './api';
import {
  ZALA_RUNS_LIMIT,
  channelsFromReport,
  compareStamps,
  fetchMetricsJson,
  parseChannels,
  quoteFilterValue,
  readStamp,
  searchZalaRuns,
  searchZalaTraces,
} from './api';

/** Имя эксперимента по умолчанию (Ф5.6); список берётся из GET /experiments. */
const DEFAULT_EXPERIMENT_NAME = 'zalabench';

/** Ключ sessionStorage с Bearer-токеном сервиса (как в JobsPage). */
const TOKEN_STORAGE_KEY = 'zala.apiToken';

/** Виды оценки судьи (Ф5.1). */
const JUDGE_KIND_OPTIONS: Array<{ value: 'single' | 'pairwise' | 'trajectory'; label: string }> = [
  { value: 'single', label: 'single — оценка ответа' },
  { value: 'pairwise', label: 'pairwise — сравнение с эталоном' },
  { value: 'trajectory', label: 'trajectory — хронология агента' },
];

/** Токен сервиса из sessionStorage (пусто — не задан). */
const readApiToken = (): string => {
  try {
    return sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
};

const CI_LOWER = '.ci_lower';
const CI_UPPER = '.ci_upper';
const STATUS_SUFFIX = '.status';

/** Пресеты фильтра по дате (URL-значение → окно в мс). */
const DAY_PRESETS: Array<{ value: string; label: string; ms: number | null }> = [
  { value: '1', label: '24 часа', ms: 24 * 60 * 60 * 1000 },
  { value: '7', label: '7 дней', ms: 7 * 24 * 60 * 60 * 1000 },
  { value: '30', label: '30 дней', ms: 30 * 24 * 60 * 60 * 1000 },
  { value: 'all', label: 'Всё время', ms: null },
];

/** Значение «фильтр не задан» для селектов. */
const ANY_VALUE = '__any__';

/** Одна строка таблицы метрик (значение + доверительный интервал + статус). */
interface MetricRow {
  key: string;
  value?: number;
  ciLower?: number;
  ciUpper?: number;
  status?: string;
}

/** Состояние фильтров страницы (дублируется в URL query). */
interface FilterState {
  experiment: string;
  model: string;
  dataset: string;
  status: string;
  days: string;
  query: string;
}

const EMPTY_FILTERS: FilterState = {
  experiment: DEFAULT_EXPERIMENT_NAME,
  model: ANY_VALUE,
  dataset: ANY_VALUE,
  status: ANY_VALUE,
  days: 'all',
  query: '',
};

/** Собирает метрики с заданным префиксом, склеивая value/CI/status. */
const collectMetrics = (run: ZalaRunSummary, prefix: string): MetricRow[] => {
  const keys = new Set<string>();
  Object.keys(run.metrics).forEach((key) => {
    if (key.startsWith(prefix) && !key.endsWith(CI_LOWER) && !key.endsWith(CI_UPPER)) {
      keys.add(key);
    }
  });
  // Статусы приходят тегами: `zala.metric.pass_at_k.status`.
  Object.keys(run.tags).forEach((key) => {
    if (key.startsWith(prefix) && key.endsWith(STATUS_SUFFIX)) {
      keys.add(key.slice(0, -STATUS_SUFFIX.length));
    }
  });
  return Array.from(keys)
    .sort()
    .map((key) => ({
      key,
      value: run.metrics[key],
      ciLower: run.metrics[`${key}${CI_LOWER}`],
      ciUpper: run.metrics[`${key}${CI_UPPER}`],
      status: run.tags[`${key}${STATUS_SUFFIX}`],
    }));
};

/** Компактный вывод числа (без хвостовых нулей). */
const formatNumber = (value: number): string => String(Number(value.toFixed(4)));

/** `value [ci_lower, ci_upper]` либо прочерк. */
const formatMetric = (row: MetricRow): string => {
  const value = row.value !== undefined ? formatNumber(row.value) : '—';
  if (row.ciLower === undefined || row.ciUpper === undefined) {
    return value;
  }
  return `${value} [${formatNumber(row.ciLower)}, ${formatNumber(row.ciUpper)}]`;
};

/** Бейдж статуса метрики (insufficient_data / not_applicable). */
const StatusBadge = ({ status }: { status?: string }) => {
  if (!status || status === 'ok') {
    return null;
  }
  const color = status === 'insufficient_data' ? 'lemon' : status === 'not_applicable' ? 'charcoal' : 'default';
  return (
    <Tag componentId="zala.metric.status" color={color}>
      {status}
    </Tag>
  );
};

/** Таблица метрик одного прогона (используется и в сравнении). */
const MetricsTable = ({ run, prefix, componentId }: { run: ZalaRunSummary; prefix: string; componentId: string }) => {
  const { theme } = useDesignSystemTheme();
  const rows = collectMetrics(run, prefix);

  return (
    <Table
      noMinHeight
      css={{
        border: `1px solid ${theme.colors.border}`,
        borderRadius: theme.general.borderRadiusBase,
        overflow: 'hidden',
      }}
    >
      <TableRow isHeader>
        <TableHeader componentId={`${componentId}.metric_header`} css={{ flex: 2 }}>
          Метрика
        </TableHeader>
        <TableHeader componentId={`${componentId}.value_header`} css={{ flex: 2 }}>
          Значение [CI]
        </TableHeader>
        <TableHeader componentId={`${componentId}.status_header`} css={{ flex: 1 }}>
          Статус
        </TableHeader>
      </TableRow>
      {rows.map((row) => (
        <TableRow key={row.key}>
          <TableCell css={{ flex: 2 }}>
            <code>{row.key.slice(prefix.length)}</code>
          </TableCell>
          <TableCell css={{ flex: 2 }}>{formatMetric(row)}</TableCell>
          <TableCell css={{ flex: 1 }}>
            <StatusBadge status={row.status} />
          </TableCell>
        </TableRow>
      ))}
    </Table>
  );
};

/** Таблица «По каналам»: строки — каналы, столбцы — метрики. */
const ChannelTable = ({ channels }: { channels: ZalaChannel[] }) => {
  const { theme } = useDesignSystemTheme();
  // Объединение имён метрик по всем каналам — столбцы таблицы.
  const metricNames = useMemo(() => {
    const names = new Set<string>();
    channels.forEach((channel) => channel.metrics.forEach((metric) => names.add(metric.name)));
    return Array.from(names).sort();
  }, [channels]);

  if (channels.length === 0 || metricNames.length === 0) {
    return null;
  }

  return (
    <Table
      scrollable
      noMinHeight
      css={{
        border: `1px solid ${theme.colors.border}`,
        borderRadius: theme.general.borderRadiusBase,
        overflow: 'hidden',
      }}
    >
      <TableRow isHeader>
        <TableHeader componentId="zala.channels.channel_header" css={{ flex: 2, minWidth: 140 }}>
          Канал
        </TableHeader>
        {metricNames.map((name) => (
          <TableHeader
            key={name}
            componentId={`zala.channels.header.${name}`}
            css={{ flex: 2, minWidth: 150 }}
          >
            <code>{name}</code>
          </TableHeader>
        ))}
      </TableRow>
      {channels.map((channel) => {
        const byName = new Map(channel.metrics.map((metric) => [metric.name, metric]));
        return (
          <TableRow key={channel.channel}>
            <TableCell css={{ flex: 2, minWidth: 140 }}>
              <div css={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <code>{channel.channel}</code>
                {channel.nSamples !== undefined && (
                  <Typography.Text color="secondary" size="sm">
                    {channel.nSamples} сэмплов
                  </Typography.Text>
                )}
              </div>
            </TableCell>
            {metricNames.map((name) => {
              const metric = byName.get(name);
              const value =
                metric && metric.value !== null
                  ? metric.ciLower !== null && metric.ciUpper !== null
                    ? `${formatNumber(metric.value)} [${formatNumber(metric.ciLower)}, ${formatNumber(metric.ciUpper)}]`
                    : formatNumber(metric.value)
                  : '—';
              return (
                <TableCell key={name} css={{ flex: 2, minWidth: 150 }}>
                  <div css={{ display: 'flex', gap: theme.spacing.xs, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span>{value}</span>
                    <StatusBadge status={metric?.status} />
                  </div>
                </TableCell>
              );
            })}
          </TableRow>
        );
      })}
    </Table>
  );
};

/** Список вердиктов по сэмплам выбранного прогона. */
const VerdictsBlock = ({ run, experimentId }: { run: ZalaRunSummary; experimentId: string }) => {
  const { theme } = useDesignSystemTheme();
  const [traces, setTraces] = useState<ZalaTrace[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Тикет #14: блок свёрнут по умолчанию (при 100 сэмплах — несколько экранов).
  const [isBlockOpen, setIsBlockOpen] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const evalId = run.params?.['eval_id'];

  useEffect(() => {
    let cancelled = false;
    setExpanded(new Set());
    setIsBlockOpen(false);
    if (!evalId) {
      setTraces([]);
      setError(null);
      return () => {
        cancelled = true;
      };
    }
    setIsLoading(true);
    setError(null);
    // Фильтр по eval_id прогона: трейсы судьи к этому прогону не относятся.
    const filter = `tags.\`inspect.eval_id\` = ${quoteFilterValue(evalId)}`;
    searchZalaTraces(experimentId, filter)
      .then((result) => {
        if (!cancelled) {
          setTraces(result);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setTraces([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [evalId, reloadToken, experimentId]);

  // E4: трейсов нет — блок скрыт.
  if (!evalId) {
    return null;
  }
  if (isLoading) {
    return (
      <div css={{ display: 'flex', gap: theme.spacing.sm, padding: theme.spacing.md, alignItems: 'center' }}>
        <Spinner size="small" />
        <Typography.Text color="secondary">Загрузка вердиктов…</Typography.Text>
      </div>
    );
  }
  if (error) {
    return (
      <Alert
        componentId="zala.verdicts.error"
        type="error"
        message="Не удалось загрузить вердикты"
        description={error}
        actions={[{ componentId: 'zala.verdicts.retry', children: 'Повторить', onClick: () => setReloadToken((n) => n + 1) }]}
      />
    );
  }
  if (traces.length === 0) {
    return null;
  }

  const toggle = (traceId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(traceId)) {
        next.delete(traceId);
      } else {
        next.add(traceId);
      }
      return next;
    });
  };

  return (
    <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.sm }}>
      <div css={{ display: 'flex', gap: theme.spacing.sm, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button
          componentId="zala.verdicts.toggle"
          type="link"
          onClick={() => setIsBlockOpen((prev) => !prev)}
          aria-expanded={isBlockOpen}
        >
          {isBlockOpen ? 'Свернуть' : 'Развернуть'} ({traces.length} сэмплов)
        </Button>
      </div>
      {isBlockOpen && (
    <Table
      noMinHeight
      css={{
        border: `1px solid ${theme.colors.border}`,
        borderRadius: theme.general.borderRadiusBase,
        overflow: 'hidden',
      }}
    >
      <TableRow isHeader>
        <TableHeader componentId="zala.verdicts.sample_header" css={{ flex: 2 }}>
          Сэмпл
        </TableHeader>
        <TableHeader componentId="zala.verdicts.count_header" css={{ flex: 1 }}>
          Вердиктов
        </TableHeader>
        <TableHeader componentId="zala.verdicts.source_header" css={{ flex: 2 }}>
          Судья
        </TableHeader>
        <TableHeader componentId="zala.verdicts.rationale_header" css={{ flex: 4 }}>
          Вердикт
        </TableHeader>
      </TableRow>
      {traces.map((trace) => {
        const isOpen = expanded.has(trace.traceId);
        const sources = Array.from(new Set(trace.assessments.map((a) => a.sourceId))).join(', ');
        return (
          <Fragment key={trace.traceId}>
            <TableRow
              css={{ cursor: 'pointer' }}
              onClick={() => toggle(trace.traceId)}
              aria-expanded={isOpen}
            >
              <TableCell css={{ flex: 2 }}>
                <Typography.Text>{trace.sampleId}</Typography.Text>
              </TableCell>
              <TableCell css={{ flex: 1 }}>{trace.assessments.length}</TableCell>
              <TableCell css={{ flex: 2 }}>{sources || '—'}</TableCell>
              <TableCell css={{ flex: 4 }}>
                <Typography.Text color="secondary">{isOpen ? 'Свернуть' : 'Показать rationale'}</Typography.Text>
              </TableCell>
            </TableRow>
            {isOpen && (
              <TableRow>
                <TableCell css={{ flex: 9, display: 'block' }} wrapContent={false}>
                  {trace.assessments.length === 0 ? (
                    <Typography.Text color="secondary">Вердиктов нет</Typography.Text>
                  ) : (
                    <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.sm }}>
                      {trace.assessments.map((assessment, index) => (
                        <div key={`${assessment.name}-${index}`} css={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <div css={{ display: 'flex', gap: theme.spacing.sm, alignItems: 'center' }}>
                            <strong>{assessment.name}</strong>
                            <Tag componentId="zala.verdict.value" color="indigo">
                              {assessment.value !== null ? formatNumber(assessment.value) : '—'}
                            </Tag>
                            <Typography.Text color="secondary">
                              {assessment.sourceType} · {assessment.sourceId}
                            </Typography.Text>
                          </div>
                          {assessment.rationale && (
                            <Typography.Paragraph css={{ margin: 0 }}>{assessment.rationale}</Typography.Paragraph>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </TableCell>
              </TableRow>
            )}
          </Fragment>
        );
      })}
    </Table>
      )}
    </div>
  );
};

/** Человекочитаемые имена полей штампа. */
const STAMP_LABELS: Record<string, string> = {
  dataset: 'dataset',
  scoring: 'scoring',
  judge: 'judge',
  ground_truth: 'ground_truth',
  prompts: 'prompts',
};

/** Сравнение двух прогонов по объединению метрик с CI. */
const ComparisonBlock = ({ left, right }: { left: ZalaRunSummary; right: ZalaRunSummary }) => {
  const { theme } = useDesignSystemTheme();
  const diff = useMemo(() => compareStamps(readStamp(left.tags), readStamp(right.tags)), [left, right]);
  const rows = useMemo(() => {
    const map = new Map<string, { left?: MetricRow; right?: MetricRow }>();
    [left, right].forEach((run, index) => {
      [...collectMetrics(run, 'zala.metric.'), ...collectMetrics(run, 'zala.judge.')].forEach((row) => {
        const entry = map.get(row.key) ?? {};
        if (index === 0) {
          entry.left = row;
        } else {
          entry.right = row;
        }
        map.set(row.key, entry);
      });
    });
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [left, right]);

  const diffText = diff.diffs.map((name) => STAMP_LABELS[name] ?? name).join(', ');

  return (
    <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.md }}>
      {/* Маркировка несравнимости: числа показываются, но с пометкой. */}
      {!diff.comparable && (
        <Alert
          componentId="zala.compare.incomparable"
          type="warning"
          message={
            <span css={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>
              {`Прогоны несравнимы: различается ${diffText}`}
            </span>
          }
          description={
            diff.judgeStampDiffers && !diff.diffs.some((name) => name !== 'judge')
              ? 'Различается судейский штамп (zala.judge.stamp) — судейские метрики сравнивать нельзя.'
              : 'Штампы N-X различаются — метрики посчитаны на разных условиях. Числа показаны справочно.'
          }
        />
      )}

      {rows.length === 0 ? (
        <Typography.Paragraph color="secondary">У выбранных прогонов нет метрик для сравнения.</Typography.Paragraph>
      ) : (
        <Table
          noMinHeight
          css={{
            border: `1px solid ${theme.colors.border}`,
            borderRadius: theme.general.borderRadiusBase,
            overflow: 'hidden',
          }}
        >
          <TableRow isHeader>
            <TableHeader componentId="zala.compare.metric_header" css={{ flex: 2 }}>
              Метрика
            </TableHeader>
            <TableHeader componentId="zala.compare.left_header" css={{ flex: 2 }}>
              {left.runName}
            </TableHeader>
            <TableHeader componentId="zala.compare.right_header" css={{ flex: 2 }}>
              {right.runName}
            </TableHeader>
          </TableRow>
          {rows.map(([key, pair]) => (
            <TableRow key={key}>
              <TableCell css={{ flex: 2 }}>
                <code>{key}</code>
              </TableCell>
              <TableCell css={{ flex: 2 }}>
                {pair.left ? formatMetric(pair.left) : '—'}
                {pair.left?.status && <> <StatusBadge status={pair.left.status} /></>}
              </TableCell>
              <TableCell css={{ flex: 2 }}>
                {pair.right ? formatMetric(pair.right) : '—'}
                {pair.right?.status && <> <StatusBadge status={pair.right.status} /></>}
              </TableCell>
            </TableRow>
          ))}
        </Table>
      )}
    </div>
  );
};

/** Разбивка по каналам выбранного прогона (metrics.json → fallback на ключи). */
const ChannelsBlock = ({ run }: { run: ZalaRunSummary }) => {
  const { theme } = useDesignSystemTheme();
  const [channels, setChannels] = useState<ZalaChannel[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  // Тикет #14: свёрнуто по умолчанию — при одном канале цифры дублируют основную таблицу.
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setIsOpen(false);
    // E4: artifact не читается — остаются каналы из ключей метрик.
    fetchMetricsJson(run.runId)
      .then((report) => {
        if (cancelled) {
          return;
        }
        const fromReport = channelsFromReport(report);
        setChannels(fromReport.length > 0 ? fromReport : parseChannels(run.metrics, run.tags));
      })
      .catch(() => {
        if (!cancelled) {
          setChannels(parseChannels(run.metrics, run.tags));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [run]);

  if (isLoading && channels.length === 0) {
    return (
      <div css={{ display: 'flex', gap: theme.spacing.sm, alignItems: 'center' }}>
        <Spinner size="small" />
        <Typography.Text color="secondary">Загрузка каналов…</Typography.Text>
      </div>
    );
  }

  // E2: каналов нет — блок (вместе с заголовком) скрыт.
  if (channels.length === 0) {
    return null;
  }

  const summary =
    channels.length === 1
      ? 'один канал — цифры совпадают с основной таблицей'
      : `${channels.length} канала(ов)`;

  return (
    <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.sm }}>
      <div css={{ display: 'flex', gap: theme.spacing.sm, alignItems: 'center', flexWrap: 'wrap' }}>
        <Typography.Title level={5} css={{ margin: 0 }}>
          По каналам
        </Typography.Title>
        <Button
          componentId="zala.channels.toggle"
          type="link"
          onClick={() => setIsOpen((prev) => !prev)}
          aria-expanded={isOpen}
        >
          {isOpen ? 'Свернуть' : 'Развернуть'} ({summary})
        </Button>
      </div>
      {isOpen && <ChannelTable channels={channels} />}
    </div>
  );
};

/** Модалка «Оценить»: судья + режим -> POST /judge -> job в очереди (Ф5.1). */
/** Форматирование числа метрики (4 знака, как в таблицах метрик). */
const formatScore = (value: number | null | undefined): string =>
  typeof value === 'number' && Number.isFinite(value) ? formatNumber(value) : '—';

/**
 * Ф5.2: агрегат составного прогона.
 *
 * Плашка с общим скором (взвешенное по сэмплам среднее) и CI, раскрытие
 * списка прогонов группы и маркировка несравнимости, когда внутри группы
 * различаются измерительные компоненты N-X (scoring/judge).
 */
const GroupBlock = ({ groupId }: { groupId: string }) => {
  const { theme } = useDesignSystemTheme();
  const [group, setGroup] = useState<ZalaGroup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [expanded, setExpanded] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setGroup(null);
    setExpanded(false);
    getGroup(groupId)
      .then((result) => {
        if (!cancelled) {
          setGroup(result);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [groupId]);

  if (isLoading) {
    return <Spinner size="small" />;
  }
  if (error) {
    return (
      <Typography.Text color="secondary">
        Агрегат группы недоступен: {error}
      </Typography.Text>
    );
  }
  if (!group) {
    return null;
  }

  const hasScore = group.score !== null;
  const ciText =
    group.ciLower !== null && group.ciUpper !== null
      ? `95% CI: ${formatScore(group.ciLower)} … ${formatScore(group.ciUpper)}`
      : null;

  return (
    <div
      css={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing.sm,
        padding: theme.spacing.md,
        border: `1px solid ${theme.colors.border}`,

        borderRadius: theme.general.borderRadiusBase,
      }}
    >
      <div css={{ display: 'flex', alignItems: 'center', gap: theme.spacing.sm, flexWrap: 'wrap' }}>
        <Typography.Title level={5} css={{ marginBottom: 0 }}>
          Составной прогон
        </Typography.Title>
        <Tag componentId="zala.group.id" title={group.groupId}>
          группа {group.groupId.slice(0, 8)}
        </Tag>
        {!group.comparable && (
          <Tag componentId="zala.group.incomparable" color="coral">
            несравнимо
          </Tag>
        )}
      </div>

      {hasScore ? (
        <div css={{ display: 'flex', gap: theme.spacing.lg, flexWrap: 'wrap' }}>
          <div>
            <Typography.Text color="secondary" size="sm">
              Общий скор
            </Typography.Text>
            <div>
              <Typography.Text css={{ fontSize: 24, fontWeight: 600 }}>
                {formatScore(group.score)}
              </Typography.Text>
            </div>
          </div>
          <div>
            <Typography.Text color="secondary" size="sm">
              Сэмплов
            </Typography.Text>
            <div>{group.samples}</div>
          </div>
          <div>
            <Typography.Text color="secondary" size="sm">
              Прогонов
            </Typography.Text>
            <div>{group.runs.length}</div>
          </div>
          {ciText && (
            <div>
              <Typography.Text color="secondary" size="sm">
                Доверительный интервал
              </Typography.Text>
              <div>{ciText}</div>
            </div>
          )}
        </div>
      ) : (
        <Typography.Text color="secondary">
          Метрик пока нет — прогоны группы ещё не завершились.
        </Typography.Text>
      )}

      {!group.comparable && (
        <Alert
          componentId="zala.group.incomparable_alert"
          type="warning"
          message="Агрегат нельзя читать как одно число"
          description={`Внутри группы различаются измерительные компоненты: ${group.incomparableFields.join(', ')}. Сравнивайте прогоны по отдельности.`}
        />
      )}

      <div>
        <Typography.Link
          componentId="zala.group.expand"
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded ? 'Свернуть прогоны группы' : `Прогоны группы (${group.runs.length})`}
        </Typography.Link>
      </div>

      {expanded && (
        <Table
          noMinHeight
          css={{
            border: `1px solid ${theme.colors.border}`,
            borderRadius: theme.general.borderRadiusBase,
            overflow: 'hidden',
          }}
        >
          <TableRow isHeader>
            <TableHeader componentId="zala.group.run_header" css={{ flex: 2 }}>
              Прогон
            </TableHeader>
            <TableHeader componentId="zala.group.dataset_header" css={{ flex: 1.5 }}>
              Датасет
            </TableHeader>
            <TableHeader componentId="zala.group.status_header" css={{ flex: 1 }}>
              Статус
            </TableHeader>
            <TableHeader componentId="zala.group.score_header" css={{ flex: 1 }}>
              Скор
            </TableHeader>
            <TableHeader componentId="zala.group.samples_header" css={{ flex: 0.8 }}>
              Сэмплов
            </TableHeader>
          </TableRow>
          {group.runs.map((run) => (
            <TableRow key={run.runId}>
              <TableCell css={{ flex: 2 }}>{run.runName || run.runId.slice(0, 8)}</TableCell>
              <TableCell css={{ flex: 1.5 }}>{run.dataset}</TableCell>
              <TableCell css={{ flex: 1 }}>
                <StatusBadge status={run.status} />
              </TableCell>
              <TableCell css={{ flex: 1 }}>{formatScore(run.score)}</TableCell>
              <TableCell css={{ flex: 0.8 }}>{run.samples}</TableCell>
            </TableRow>
          ))}
        </Table>
      )}
    </div>
  );
};

const JudgeModal = ({
  run,
  visible,
  onClose,
}: {
  run: ZalaRunSummary;
  visible: boolean;
  onClose: () => void;
}) => {
  const { theme } = useDesignSystemTheme();
  const [models, setModels] = useState<string[]>([]);
  const [judgeModel, setJudgeModel] = useState<string>('');
  const [kinds, setKinds] = useState<Array<'single' | 'pairwise' | 'trajectory'>>(['single']);
  const [referenceRunId, setReferenceRunId] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Список моделей — из сервиса (не хардкод), модель прогона исключена:
  // судья не может оценивать сам себя.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    listModels()
      .then((items) => {
        if (cancelled) return;
        const available = items.filter((name) => name !== run.model);
        setModels(available);
        setJudgeModel((prev) => (prev && available.includes(prev) ? prev : available[0] ?? ''));
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, run.model]);

  useEffect(() => {
    if (!visible) {
      setError(null);
      setNotice(null);
      setKinds(['single']);
      setReferenceRunId('');
    }
  }, [visible]);

  const toggleKind = (kind: 'single' | 'pairwise' | 'trajectory') => {
    setKinds((prev) => (prev.includes(kind) ? prev.filter((item) => item !== kind) : [...prev, kind]));
  };

  const onSubmit = async () => {
    const token = readApiToken();
    if (!token) {
      setError('введите токен на вкладке «Очередь» — без него судейство недоступно');
      return;
    }
    if (!judgeModel) {
      setError('выберите модель-судью');
      return;
    }
    if (kinds.length === 0) {
      setError('выберите хотя бы один режим оценки');
      return;
    }
    if (kinds.includes('pairwise') && !referenceRunId.trim()) {
      setError('pairwise требует run_id прогона-эталона');
      return;
    }
    setIsSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const job = await createJudgeJob(
        {
          runId: run.runId,
          judgeModel,
          kinds,
          referenceRunId: referenceRunId.trim() || undefined,
        },
        token,
      );
      setNotice(`Job ${job.jobId.slice(0, 8)} поставлен в очередь (судья ${judgeModel}).`);
    } catch (e: unknown) {
      if (e instanceof ZalaApiError && e.status === 401) {
        setError('неверный токен');
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      componentId="zala.judge.modal"
      title={`Оценить прогон ${run.runName}`}
      visible={visible}
      onCancel={onClose}
      onOk={onSubmit}
      okText={isSubmitting ? 'Постановка…' : 'Поставить в очередь'}
      okButtonProps={{ loading: isSubmitting }}
      cancelText="Закрыть"
    >
      <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.md }}>
        <div>
          <Typography.Text color="secondary">Модель-судья</Typography.Text>
          <SimpleSelect
            id="zala-judge-model"
            componentId="zala.judge.model"
            value={judgeModel}
            onChange={({ target }) => setJudgeModel(target.value)}
          >
            {models.length === 0 ? (
              <SimpleSelectOption value="">нет доступных моделей</SimpleSelectOption>
            ) : (
              models.map((name) => (
                <SimpleSelectOption key={name} value={name}>
                  {name}
                </SimpleSelectOption>
              ))
            )}
          </SimpleSelect>
        </div>

        <div>
          <Typography.Text color="secondary">Режим оценки</Typography.Text>
          <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.xs }}>
            {JUDGE_KIND_OPTIONS.map((option) => (
              <Checkbox
                key={option.value}
                componentId={`zala.judge.kind.${option.value}`}
                isChecked={kinds.includes(option.value)}
                onChange={() => toggleKind(option.value)}
              >
                {option.label}
              </Checkbox>
            ))}
          </div>
        </div>

        {kinds.includes('pairwise') && (
          <div>
            <Typography.Text color="secondary">run_id прогона-эталона (pairwise)</Typography.Text>
            <Input
              componentId="zala.judge.reference"
              value={referenceRunId}
              onChange={(e) => setReferenceRunId(e.target.value)}
              placeholder="например, 08af94838b294cb5b601c80f04ebcf29"
            />
          </div>
        )}

        {error && (
          <Alert componentId="zala.judge.error" type="error" message="Судейство не поставлено" description={error} />
        )}
        {notice && (
          <Alert
            componentId="zala.judge.notice"
            type="success"
            message={notice}
            closable
            onClose={() => setNotice(null)}
          />
        )}
      </div>
    </Modal>
  );
};

/** Читает фильтры из URL query. */
const filtersFromParams = (params: URLSearchParams): FilterState => ({
  experiment: params.get('exp') || DEFAULT_EXPERIMENT_NAME,
  model: params.get('model') || ANY_VALUE,
  dataset: params.get('dataset') || ANY_VALUE,
  status: params.get('status') || ANY_VALUE,
  days: params.get('days') || 'all',
  query: params.get('q') || '',
});

/** Записывает фильтры в URL query (пустые значения не пишем). */
const filtersToParams = (filters: FilterState): Record<string, string> => {
  const result: Record<string, string> = {};
  if (filters.experiment && filters.experiment !== DEFAULT_EXPERIMENT_NAME) {
    result['exp'] = filters.experiment;
  }
  if (filters.model !== ANY_VALUE) {
    result['model'] = filters.model;
  }
  if (filters.dataset !== ANY_VALUE) {
    result['dataset'] = filters.dataset;
  }
  if (filters.status !== ANY_VALUE) {
    result['status'] = filters.status;
  }
  if (filters.days !== 'all') {
    result['days'] = filters.days;
  }
  if (filters.query.trim()) {
    result['q'] = filters.query;
  }
  return result;
};

export const ZalaPage = () => {
  const { theme } = useDesignSystemTheme();
  const [searchParams, setSearchParams] = useSearchParams();
  const [runs, setRuns] = useState<ZalaRunSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [experiments, setExperiments] = useState<{ name: string; experimentId: string }[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [compareRunId, setCompareRunId] = useState<string | null>(null);
  // Ф5.8 M2: режим сравнения — чекбоксы видны только в нём, клик по строке
  // выбирает второй прогон; вне режима клик открывает детали.
  const [compareMode, setCompareMode] = useState<boolean>(false);
  // Ф5.1: модалка «Оценить» для выбранного прогона.
  const [judgeModalOpen, setJudgeModalOpen] = useState<boolean>(false);

  // Состояние фильтров живёт в URL, чтобы ссылку можно было передать.
  const filters = useMemo(() => filtersFromParams(searchParams), [searchParams]);
  const updateFilters = useCallback(
    (patch: Partial<FilterState>) => {
      const next = { ...filters, ...patch };
      setSearchParams(filtersToParams(next), { replace: true });
    },
    [filters, setSearchParams],
  );

  // Список экспериментов — из сервиса (не хардкод), Ф5.6.
  useEffect(() => {
    let cancelled = false;
    listExperiments()
      .then((items) => {
        if (!cancelled) {
          setExperiments(items);
        }
      })
      .catch(() => {
        // Список недоступен — остаётся выбор по умолчанию (zalabench).
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** id выбранного эксперимента: по имени из URL, иначе zalabench/первый. */
  const activeExperimentId = useMemo(() => {
    const match = experiments.find((item) => item.name === filters.experiment);
    if (match) {
      return match.experimentId;
    }
    const fallback =
      experiments.find((item) => item.name === DEFAULT_EXPERIMENT_NAME) ?? experiments[0];
    return fallback?.experimentId ?? '';
  }, [experiments, filters.experiment]);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    if (!activeExperimentId) {
      // Эксперименты ещё не загружены — ждём, чтобы не ходить в MLflow наугад.
      return () => {
        cancelled = true;
      };
    }
    searchZalaRuns(activeExperimentId)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setRuns(result);
        // По умолчанию выбираем первый (самый свежий) прогон.
        setSelectedRunId((prev) => (prev && result.some((r) => r.runId === prev) ? prev : result[0]?.runId ?? null));
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setRuns([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken, activeExperimentId]);

  // Уникальные значения для селектов фильтров.
  const modelOptions = useMemo(
    () => Array.from(new Set(runs.map((run) => run.model).filter(Boolean))).sort(),
    [runs],
  );
  const datasetOptions = useMemo(
    () => Array.from(new Set(runs.map((run) => run.dataset).filter(Boolean))).sort(),
    [runs],
  );
  const statusOptions = useMemo(
    () => Array.from(new Set(runs.map((run) => run.status).filter(Boolean))).sort(),
    [runs],
  );

  // Клиентская фильтрация: данные уже загружены (лимит 100).
  const filteredRuns = useMemo(() => {
    const preset = DAY_PRESETS.find((item) => item.value === filters.days) ?? DAY_PRESETS[DAY_PRESETS.length - 1];
    const cutoff = preset.ms === null ? null : Date.now() - preset.ms;
    const needle = filters.query.trim().toLowerCase();
    return runs.filter((run) => {
      if (filters.model !== ANY_VALUE && run.model !== filters.model) {
        return false;
      }
      if (filters.dataset !== ANY_VALUE && run.dataset !== filters.dataset) {
        return false;
      }
      if (filters.status !== ANY_VALUE && run.status !== filters.status) {
        return false;
      }
      if (cutoff !== null && (!run.startTime || run.startTime < cutoff)) {
        return false;
      }
      if (needle && !run.runName.toLowerCase().includes(needle)) {
        return false;
      }
      return true;
    });
  }, [runs, filters]);

  const selectedRun = useMemo(() => runs.find((run) => run.runId === selectedRunId), [runs, selectedRunId]);
  const compareRun = useMemo(() => runs.find((run) => run.runId === compareRunId), [runs, compareRunId]);

  const staticMetrics = selectedRun ? collectMetrics(selectedRun, 'zala.metric.') : [];
  const judgeMetrics = selectedRun ? collectMetrics(selectedRun, 'zala.judge.') : [];

  const selectRun = useCallback((runId: string) => {
    setSelectedRunId(runId);
    setCompareRunId((prev) => (prev === runId ? null : prev));
  }, []);

  const toggleCompare = useCallback((runId: string) => {
    setCompareRunId((prev) => (prev === runId ? null : runId));
  }, []);

  // Ф5.8 M2: переключение режима сравнения сбрасывает выбранный второй прогон.
  const toggleCompareMode = useCallback(() => {
    setCompareMode((prev) => !prev);
    setCompareRunId(null);
  }, []);

  // Ф5.8 M2: клик по строке — в режиме сравнения выбирает второй прогон,
  // иначе открывает детали (старое поведение).
  const handleRowClick = useCallback(
    (runId: string) => {
      if (compareMode) {
        setCompareRunId((prev) => (prev === runId ? null : runId));
      } else {
        selectRun(runId);
      }
    },
    [compareMode, selectRun],
  );

  const hasFilters =
    filters.experiment !== DEFAULT_EXPERIMENT_NAME ||
    filters.model !== ANY_VALUE ||
    filters.dataset !== ANY_VALUE ||
    filters.status !== ANY_VALUE ||
    filters.days !== 'all' ||
    filters.query.trim() !== '';

  return (
    <div css={{ padding: theme.spacing.lg, display: 'flex', flexDirection: 'column', gap: theme.spacing.lg }}>
      <div>
        <Typography.Title level={2}>ZALABench</Typography.Title>
        <Typography.Paragraph color="secondary" css={{ marginBottom: 0 }}>
          Прогоны бенчмарка, метрики и вердикты судьи. Данные читаются из MLflow REST.
        </Typography.Paragraph>
      </div>

      {/* E3: MLflow недоступен — сообщение и повтор. */}
      {error && (
        <Alert
          componentId="zala.runs.error"
          type="error"
          message="Не удалось получить прогоны из MLflow"
          description={error}
          actions={[{ componentId: 'zala.runs.retry', children: 'Повторить', onClick: () => setReloadToken((n) => n + 1) }]}
        />
      )}

      {isLoading ? (
        <div css={{ display: 'flex', gap: theme.spacing.sm, padding: theme.spacing.lg, alignItems: 'center' }}>
          <Spinner size="small" />
          <Typography.Text color="secondary">Загрузка прогонов…</Typography.Text>
        </div>
      ) : !error && runs.length === 0 ? (
        /* E1: прогонов нет. */
        <Empty
          title="Прогонов пока нет"
          description="Запустите бенчмарк — прогоны появятся здесь после публикации в MLflow."
        />
      ) : !error ? (
        <div css={{ display: 'flex', gap: theme.spacing.lg, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {/* Левая колонка — фильтры и таблица прогонов. */}
          <div css={{ flex: '1 1 480px', minWidth: 0 }}>
            <Typography.Title level={4}>Прогоны</Typography.Title>
            {runs.length >= ZALA_RUNS_LIMIT && (
              <Typography.Paragraph color="secondary">
                Показаны первые {ZALA_RUNS_LIMIT} прогонов.
              </Typography.Paragraph>
            )}

            {/* Фильтры и поиск (состояние — в URL query). */}
            <div
              css={{
                display: 'flex',
                gap: theme.spacing.sm,
                flexWrap: 'wrap',
                alignItems: 'flex-end',
                marginBottom: theme.spacing.sm,
              }}
            >
              <div css={{ flex: '1 1 160px', minWidth: 130 }}>
                <Typography.Text color="secondary" size="sm">
                  Эксперимент
                </Typography.Text>
                <SimpleSelect
                  id="zala-filter-experiment"
                  componentId="zala.filters.experiment"
                  value={filters.experiment}
                  onChange={({ target }) => updateFilters({ experiment: target.value })}
                >
                  {experiments.length === 0 ? (
                    <SimpleSelectOption value={DEFAULT_EXPERIMENT_NAME}>
                      {DEFAULT_EXPERIMENT_NAME}
                    </SimpleSelectOption>
                  ) : (
                    experiments.map((item) => (
                      <SimpleSelectOption key={item.experimentId} value={item.name}>
                        {item.name}
                      </SimpleSelectOption>
                    ))
                  )}
                </SimpleSelect>
              </div>
              <div css={{ flex: '1 1 140px', minWidth: 120 }}>
                <Typography.Text color="secondary" size="sm">
                  Модель
                </Typography.Text>
                <SimpleSelect
                  id="zala-filter-model"
                  componentId="zala.filters.model"
                  value={filters.model}
                  onChange={({ target }) => updateFilters({ model: target.value })}
                >
                  <SimpleSelectOption value={ANY_VALUE}>Все</SimpleSelectOption>
                  {modelOptions.map((option) => (
                    <SimpleSelectOption key={option} value={option}>
                      {option}
                    </SimpleSelectOption>
                  ))}
                </SimpleSelect>
              </div>
              <div css={{ flex: '1 1 140px', minWidth: 120 }}>
                <Typography.Text color="secondary" size="sm">
                  Датасет
                </Typography.Text>
                <SimpleSelect
                  id="zala-filter-dataset"
                  componentId="zala.filters.dataset"
                  value={filters.dataset}
                  onChange={({ target }) => updateFilters({ dataset: target.value })}
                >
                  <SimpleSelectOption value={ANY_VALUE}>Все</SimpleSelectOption>
                  {datasetOptions.map((option) => (
                    <SimpleSelectOption key={option} value={option}>
                      {option}
                    </SimpleSelectOption>
                  ))}
                </SimpleSelect>
              </div>
              <div css={{ flex: '1 1 120px', minWidth: 110 }}>
                <Typography.Text color="secondary" size="sm">
                  Статус
                </Typography.Text>
                <SimpleSelect
                  id="zala-filter-status"
                  componentId="zala.filters.status"
                  value={filters.status}
                  onChange={({ target }) => updateFilters({ status: target.value })}
                >
                  <SimpleSelectOption value={ANY_VALUE}>Все</SimpleSelectOption>
                  {statusOptions.map((option) => (
                    <SimpleSelectOption key={option} value={option}>
                      {option}
                    </SimpleSelectOption>
                  ))}
                </SimpleSelect>
              </div>
              <div css={{ flex: '1 1 120px', minWidth: 110 }}>
                <Typography.Text color="secondary" size="sm">
                  Дата
                </Typography.Text>
                <SimpleSelect
                  id="zala-filter-days"
                  componentId="zala.filters.days"
                  value={filters.days}
                  onChange={({ target }) => updateFilters({ days: target.value })}
                >
                  {DAY_PRESETS.map((preset) => (
                    <SimpleSelectOption key={preset.value} value={preset.value}>
                      {preset.label}
                    </SimpleSelectOption>
                  ))}
                </SimpleSelect>
              </div>
              <div css={{ flex: '2 1 180px', minWidth: 150 }}>
                <Typography.Text color="secondary" size="sm">
                  Поиск
                </Typography.Text>
                <Input
                  componentId="zala.filters.search"
                  value={filters.query}
                  onChange={(event) => updateFilters({ query: event.target.value })}
                  placeholder="Имя прогона…"
                />
              </div>
            </div>

            <div css={{ display: 'flex', alignItems: 'center', gap: theme.spacing.sm }}>
              {/* Ф5.8 M2: кнопка режима сравнения — без неё чекбоксов нет,
                  клик по строке открывает детали. */}
              <Button
                componentId="zala.runs.compare_mode"
                size="small"
                type={compareMode ? 'primary' : undefined}
                onClick={toggleCompareMode}
              >
                {compareMode ? 'Сравнение: вкл' : 'Сравнить'}
              </Button>
              <Typography.Paragraph color="secondary" css={{ marginBottom: 0 }}>
                Показано {filteredRuns.length} из {runs.length}
                {hasFilters && (
                  <Typography.Link
                    componentId="zala.filters.reset"
                    css={{ marginLeft: theme.spacing.sm }}
                    onClick={() => setSearchParams({}, { replace: true })}
                  >
                    Сбросить фильтры
                  </Typography.Link>
                )}
              </Typography.Paragraph>
            </div>

            {filteredRuns.length === 0 ? (
              <Empty title="Ничего не найдено" description="Измените фильтры или поисковый запрос." />
            ) : (
              <Table
                scrollable
                noMinHeight
                css={{
                  border: `1px solid ${theme.colors.border}`,
                  borderRadius: theme.general.borderRadiusBase,
                  overflow: 'hidden',
                }}
              >
                <TableRow isHeader>
                  {/* Ф5.8 M2: колонка с чекбоксами видна только в режиме сравнения. */}
                  {compareMode && (
                    <TableHeader
                      componentId="zala.runs.compare_header"
                      css={{ flex: 0, minWidth: 40, maxWidth: 40 }}
                      title="Выбор второго прогона для сравнения"
                    >
                      ⇄
                    </TableHeader>
                  )}
                  <TableHeader componentId="zala.runs.name_header" css={{ flex: 3 }}>
                    Прогон
                  </TableHeader>
                  <TableHeader componentId="zala.runs.model_header" css={{ flex: 2 }}>
                    Модель
                  </TableHeader>
                  <TableHeader componentId="zala.runs.dataset_header" css={{ flex: 2 }}>
                    Датасет
                  </TableHeader>
                  <TableHeader componentId="zala.runs.status_header" css={{ flex: 1 }}>
                    Статус
                  </TableHeader>
                  <TableHeader componentId="zala.runs.date_header" css={{ flex: 2 }}>
                    Дата
                  </TableHeader>
                </TableRow>
                {filteredRuns.map((run) => {
                  const isSelected = run.runId === selectedRunId;
                  // Иконка «несравним с выбранным» — когда второй прогон уже выбран.
                  const runDiff =
                    compareRunId && selectedRun && run.runId !== selectedRun.runId
                      ? compareStamps(readStamp(selectedRun.tags), readStamp(run.tags))
                      : null;
                  const incomparable = runDiff ? !runDiff.comparable : false;
                  return (
                    <TableRow
                      key={run.runId}
                      css={{
                        cursor: 'pointer',
                        backgroundColor: isSelected ? theme.colors.actionDefaultBackgroundHover : undefined,
                      }}
                      onClick={() => handleRowClick(run.runId)}
                      aria-selected={isSelected}
                    >
                      {compareMode && (
                        <TableCell css={{ flex: 0, minWidth: 40, maxWidth: 40 }} wrapContent={false}>
                          <span onClick={(event) => event.stopPropagation()}>
                            <Checkbox
                              componentId="zala.runs.compare_checkbox"
                              isChecked={compareRunId === run.runId}
                              onChange={() => toggleCompare(run.runId)}
                              aria-label={`Сравнить прогон ${run.runName}`}
                            />
                          </span>
                        </TableCell>
                      )}
                      <TableCell css={{ flex: 3 }}>
                        <div css={{ display: 'flex', gap: theme.spacing.xs, alignItems: 'center', flexWrap: 'wrap' }}>
                          <span>{run.runName}</span>
                          {/* Ф5.2: прогон входит в составной прогон. */}
                          {run.tags['zala.group_id'] && (
                            <Tag
                              componentId="zala.runs.group"
                              color="indigo"
                              title={`Составной прогон ${run.tags['zala.group_id']}`}
                            >
                              группа
                            </Tag>
                          )}
                          {incomparable && (
                            <Tag
                              componentId="zala.runs.incomparable"
                              color="lemon"
                              title={`Несравним с выбранным: различается ${runDiff?.diffs.join(', ')}`}
                            >
                              ≠ несравним
                            </Tag>
                          )}
                        </div>
                      </TableCell>
                      <TableCell css={{ flex: 2 }}>{run.model}</TableCell>
                      <TableCell css={{ flex: 2 }}>{run.dataset}</TableCell>
                      <TableCell css={{ flex: 1 }}>{run.status}</TableCell>
                      <TableCell css={{ flex: 2 }}>
                        {run.startTime ? new Date(run.startTime).toLocaleString() : '—'}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </Table>
            )}
          </div>

          {/* Правая колонка — детали выбранного прогона. */}
          <div css={{ flex: '1 1 520px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: theme.spacing.lg }}>
            {selectedRun ? (
              <>
                <div>
                  <Typography.Title level={4} css={{ marginBottom: theme.spacing.xs }}>
                    {selectedRun.runName}
                  </Typography.Title>
                  <Typography.Text color="secondary">
                    {selectedRun.model} · {selectedRun.dataset} · {selectedRun.status}
                  </Typography.Text>
                  <div css={{ marginTop: theme.spacing.sm }}>
                    {/* Ф5.1: судейство из UI — job в очередь, не блокирующий запрос. */}
                    <Button
                      componentId="zala.run.judge"
                      onClick={() => setJudgeModalOpen(true)}
                      disabled={selectedRun.status !== 'FINISHED'}
                    >
                      Оценить
                    </Button>
                  </div>
                </div>

                {/* Ф5.2: агрегат составного прогона (если run входит в группу). */}
                {selectedRun.tags['zala.group_id'] && (
                  <GroupBlock groupId={selectedRun.tags['zala.group_id']} />
                )}

                {/* E2: блоки метрик скрыты, если метрик нет. */}
                {staticMetrics.length > 0 && (
                  <div>
                    <Typography.Title level={5}>Статические метрики</Typography.Title>
                    <MetricsTable run={selectedRun} prefix="zala.metric." componentId="zala.metrics.static" />
                  </div>
                )}

                {/* Ф4.3: разбивка по каналам (источник — metrics.json). */}
                <ChannelsBlock run={selectedRun} />

                {judgeMetrics.length > 0 && (
                  <div>
                    <Typography.Title level={5}>Судейские метрики</Typography.Title>
                    <MetricsTable run={selectedRun} prefix="zala.judge." componentId="zala.metrics.judge" />
                  </div>
                )}

                {/* Тикет #14: блок «Ответы модели» удалён — те же данные есть в MLflow. */}
                <div>
                  <Typography.Title level={5}>Вердикты по сэмплам</Typography.Title>
                  <VerdictsBlock run={selectedRun} experimentId={activeExperimentId} />
                </div>

                {/* Ф5.1: модалка судейства (job с task="judge"). */}
                <JudgeModal
                  run={selectedRun}
                  visible={judgeModalOpen}
                  onClose={() => setJudgeModalOpen(false)}
                />

                {compareRun && (
                  <div>
                    <Typography.Title level={5}>Сравнение: {compareRun.runName}</Typography.Title>
                    <ComparisonBlock left={selectedRun} right={compareRun} />
                  </div>
                )}
              </>
            ) : (
              <Typography.Paragraph color="secondary">Выберите прогон в таблице слева.</Typography.Paragraph>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default ZalaPage;

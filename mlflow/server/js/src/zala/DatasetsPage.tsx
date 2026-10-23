/**
 * ZALABench — вкладка датасетов (Ф4.4, только просмотр).
 *
 * Список датасетов реестра, детали с сэмплами и фильтром по каналу,
 * предупреждения о малых каналах. Данные — из нашего сервиса
 * `zalabench-api` (FastAPI), не из MLflow REST (см. docs/UI-FORK.md).
 *
 * Редактирования и записи нет: страница только читает.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Empty,
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

import type { ZalaDatasetDetail, ZalaDatasetSummary, ZalaSample } from './datasetsApi';
import { getDataset, listDatasets } from './datasetsApi';
import { ZalaApiError, getApiBase } from './jobsApi';

/** Минимум сэмплов в канале для осмысленных метрик (как MIN_CHANNEL_SAMPLES). */
const MIN_CHANNEL_SAMPLES = 5;

/** Размер страницы сэмплов (E4). */
const PAGE_SIZE = 100;

/** Обрезка input в таблице сэмплов, символов. */
const INPUT_PREVIEW_CHARS = 120;

/** Компактная дата-время либо прочерк. */
const formatDate = (value: string | null): string => {
  if (!value) {
    return '—';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

/** Короткий hash для списка (первые 12 символов). */
const shortHash = (hash: string): string => (hash ? hash.slice(0, 12) : '—');

/** Текст ошибки для показа пользователю. */
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Канал сэмпла: task_type, иначе `unknown` (как в реестре). */
const channelOf = (sample: ZalaSample): string => sample.taskType || 'unknown';

/** Обрезка строки с многоточием. */
const truncate = (value: string, limit: number): string =>
  value.length > limit ? `${value.slice(0, limit)}…` : value;

/** Каналы, где сэмплов меньше минимума (E6). */
const smallChannels = (channels: Record<string, number>): string[] =>
  Object.entries(channels)
    .filter(([, count]) => count < MIN_CHANNEL_SAMPLES)
    .map(([channel]) => channel);

/** Бейджи каналов; малые каналы — красным (E6). */
const ChannelBadges = ({ channels }: { channels: Record<string, number> }) => {
  const entries = Object.entries(channels);
  if (entries.length === 0) {
    return <Typography.Text color="secondary">—</Typography.Text>;
  }
  return (
    <div css={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {entries.map(([channel, count]) => (
        <Tag
          key={channel}
          componentId="zala.datasets.channel"
          color={count < MIN_CHANNEL_SAMPLES ? 'coral' : 'default'}
        >
          {channel}: {count}
        </Tag>
      ))}
    </div>
  );
};

/** Группа датасетов (локальные / внешние) с общей таблицей. */
const DatasetGroup = ({
  title,
  hint,
  items,
  onOpen,
}: {
  title: string;
  hint: string;
  items: ZalaDatasetSummary[];
  onOpen: (name: string) => void;
}) => {
  const { theme } = useDesignSystemTheme();
  if (items.length === 0) {
    return null;
  }
  return (
    <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.xs }}>
      <div css={{ display: 'flex', gap: theme.spacing.sm, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <Typography.Title level={5} css={{ marginBottom: 0 }}>
          {title}
        </Typography.Title>
        <Typography.Text color="secondary">{items.length}</Typography.Text>
        <Typography.Text color="secondary" css={{ fontSize: 12 }}>
          {hint}
        </Typography.Text>
      </div>
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
          <TableHeader componentId="zala.datasets.name_header" css={{ flex: 2 }}>
            Имя
          </TableHeader>
          <TableHeader componentId="zala.datasets.kind_header" css={{ flex: 0.8 }}>
            Тип
          </TableHeader>
          <TableHeader componentId="zala.datasets.hash_header" css={{ flex: 1.4 }}>
            snapshot_hash
          </TableHeader>
          <TableHeader componentId="zala.datasets.samples_header" css={{ flex: 0.8 }}>
            Сэмплов
          </TableHeader>
          <TableHeader componentId="zala.datasets.revision_header" css={{ flex: 1.6 }}>
            Ревизия
          </TableHeader>
          <TableHeader componentId="zala.datasets.channels_header" css={{ flex: 2.6 }}>
            Каналы
          </TableHeader>
          <TableHeader componentId="zala.datasets.updated_header" css={{ flex: 1.2 }}>
            Обновлён
          </TableHeader>
          <TableHeader componentId="zala.datasets.warnings_header" css={{ flex: 2.2 }}>
            Предупреждения
          </TableHeader>
          <TableHeader componentId="zala.datasets.actions_header" css={{ flex: 0.8 }}>
            {' '}
          </TableHeader>
        </TableRow>
        {items.map((item) => (
          <TableRow key={item.name}>
            <TableCell css={{ flex: 2 }}>
              <Typography.Text>{item.name}</Typography.Text>
              <div>
                <Typography.Text color="secondary" css={{ fontSize: 12 }}>
                  {item.path}
                </Typography.Text>
              </div>
            </TableCell>
            <TableCell css={{ flex: 0.8 }}>
              {item.kind === 'external' ? (
                <Tag componentId="zala.datasets.kind.external" color="lemon">
                  HF
                </Tag>
              ) : (
                <Tag componentId="zala.datasets.kind.dev" color="teal">
                  dev
                </Tag>
              )}
            </TableCell>
            <TableCell css={{ flex: 1.4 }}>
              <code title={item.snapshotHash}>{shortHash(item.snapshotHash)}</code>
            </TableCell>
            <TableCell css={{ flex: 0.8 }}>{item.samples}</TableCell>
            <TableCell css={{ flex: 1.6 }}>
              {item.revision ? (
                <code title={item.revision}>{truncate(item.revision, 18)}</code>
              ) : (
                '—'
              )}
            </TableCell>
            <TableCell css={{ flex: 2.6 }}>
              <ChannelBadges channels={item.channels} />
            </TableCell>
            <TableCell css={{ flex: 1.2 }}>{formatDate(item.updatedAt)}</TableCell>
            <TableCell css={{ flex: 2.2 }}>
              {item.warnings.length === 0 ? (
                '—'
              ) : (
                <div css={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {item.warnings.map((warning, index) => (
                    <Typography.Text key={`${item.name}-${index}`} color="error">
                      {warning}
                    </Typography.Text>
                  ))}
                </div>
              )}
            </TableCell>
            <TableCell css={{ flex: 0.8 }}>
              <Button componentId="zala.datasets.open" onClick={() => onOpen(item.name)}>
                Открыть
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </Table>
    </div>
  );
};

/** Тикет #9: модалка сэмпла — полный input/target с переносом и прокруткой. */
const SampleModal = ({
  sample,
  truncated,
  onClose,
}: {
  sample: ZalaSample | null;
  truncated: boolean;
  onClose: () => void;
}) => {
  const { theme } = useDesignSystemTheme();
  if (!sample) {
    return null;
  }
  const textStyle = {
    margin: 0,
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
    maxHeight: 320,
    overflowY: 'auto' as const,
    padding: theme.spacing.sm,
    border: `1px solid ${theme.colors.border}`,
    borderRadius: theme.general.borderRadiusBase,
    backgroundColor: theme.colors.backgroundSecondary,
    fontFamily: 'monospace',
    fontSize: 12,
  };
  return (
    <Modal
      componentId="zala.datasets.sample_modal"
      title={`Сэмпл ${sample.id}`}
      visible={Boolean(sample)}
      onCancel={onClose}
      footer={null}
      size="wide"
    >
      <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.md }}>
        <div css={{ display: 'flex', gap: theme.spacing.sm, alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography.Text color="secondary">task_type:</Typography.Text>
          {sample.taskType ? (
            <Tag componentId="zala.datasets.sample_modal.task">{sample.taskType}</Tag>
          ) : (
            <Tag componentId="zala.datasets.sample_modal.task_unknown" color="coral">
              unknown
            </Tag>
          )}
        </div>

        {truncated && (
          <Alert
            componentId="zala.datasets.sample_modal.truncated"
            type="info"
            message="Список сэмплов неполный"
            description="Внешний датасет: в UI загружены только первые сэмплы выборки MVP. Полный датасет грузится из HF при прогоне."
          />
        )}

        <div>
          <Typography.Text color="secondary">input</Typography.Text>
          <pre css={textStyle}>{sample.input || '—'}</pre>
        </div>

        <div>
          <Typography.Text color="secondary">target</Typography.Text>
          <pre css={textStyle}>{sample.target || '—'}</pre>
        </div>
      </div>
    </Modal>
  );
};

/** Красная плашка о каналах с недостатком сэмплов (E6). */
const SmallChannelAlert = ({ channels }: { channels: Record<string, number> }) => {
  const small = smallChannels(channels);
  if (small.length === 0) {
    return null;
  }
  const description = small
    .map((channel) => `${channel}: ${channels[channel]} сэмплов (< ${MIN_CHANNEL_SAMPLES})`)
    .join('; ');
  return (
    <Alert
      componentId="zala.datasets.small_channels"
      type="error"
      message="В каналах недостаточно сэмплов"
      description={`${description}. Метрики по этим каналам будут insufficient_data.`}
    />
  );
};

export const DatasetsPage = () => {
  const { theme } = useDesignSystemTheme();

  const [datasets, setDatasets] = useState<ZalaDatasetSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<{ message: string; offline: boolean } | null>(null);

  // Выбранный датасет и его детали.
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [detail, setDetail] = useState<ZalaDatasetDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<{ message: string; notFound: boolean } | null>(null);

  // Фильтр по каналу и пагинация (E4).
  const [channelFilter, setChannelFilter] = useState<string>('all');
  const [page, setPage] = useState(0);

  // Тикет #9: открытый сэмпл — модалка с полным input/target.
  const [activeSample, setActiveSample] = useState<ZalaSample | null>(null);

  /** Загружает список датасетов; `initial` включает большой Spinner. */
  const refresh = useCallback(async (initial = false) => {
    if (initial) {
      setIsLoading(true);
    } else {
      setIsRefreshing(true);
    }
    try {
      const result = await listDatasets();
      setDatasets(result);
      setLoadError(null);
    } catch (e: unknown) {
      const offline = e instanceof ZalaApiError && e.status === 0;
      setLoadError({ message: errorText(e), offline });
      if (offline) {
        setDatasets([]);
      }
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  // Первичная загрузка списка.
  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  /** Открывает детали датасета (E2: 404 -> сообщение и возврат к списку). */
  const openDataset = useCallback(async (name: string) => {
    setSelectedName(name);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    setChannelFilter('all');
    setPage(0);
    try {
      const result = await getDataset(name);
      setDetail(result);
    } catch (e: unknown) {
      const notFound = e instanceof ZalaApiError && e.status === 404;
      setDetailError({ message: errorText(e), notFound });
    } finally {
      setDetailLoading(false);
    }
  }, []);

  /** Возврат к списку. */
  const closeDetail = useCallback(() => {
    setSelectedName(null);
    setDetail(null);
    setDetailError(null);
    setChannelFilter('all');
    setPage(0);
    setActiveSample(null);
  }, []);

  /** Сэмплы после фильтра по каналу. */
  const filteredSamples = useMemo(() => {
    if (!detail) {
      return [];
    }
    if (channelFilter === 'all') {
      return detail.samplesList;
    }
    return detail.samplesList.filter((sample) => channelOf(sample) === channelFilter);
  }, [detail, channelFilter]);

  /** E4: пагинация по 100, когда сэмплов много. */
  const isPaged = filteredSamples.length > PAGE_SIZE;
  const pageCount = isPaged ? Math.ceil(filteredSamples.length / PAGE_SIZE) : 1;
  const currentPage = Math.min(page, Math.max(pageCount - 1, 0));
  const visibleSamples = isPaged
    ? filteredSamples.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
    : filteredSamples;

  const isServiceDown = Boolean(loadError?.offline);
  const selectedSummary = datasets.find((item) => item.name === selectedName) ?? null;
  const detailWarnings = detail?.warnings ?? selectedSummary?.warnings ?? [];
  /** E3: датасет не читается — в warnings есть причина от реестра. */
  const detailBroken = detailWarnings.some((warning) => warning.startsWith('не читается'));

  /** Локальные и внешние датасеты — раздельные группы списка. */
  const localDatasets = useMemo(() => datasets.filter((item) => item.kind !== 'external'), [datasets]);
  const externalDatasets = useMemo(() => datasets.filter((item) => item.kind === 'external'), [datasets]);

  /** Опции фильтра: все каналы датасета + `all`. */
  const channelOptions = useMemo(() => {
    const channels = detail ? Object.keys(detail.channels) : [];
    return ['all', ...channels];
  }, [detail]);

  return (
    <div css={{ padding: theme.spacing.lg, display: 'flex', flexDirection: 'column', gap: theme.spacing.lg }}>
      {/* Шапка: заголовок, статус обновления, кнопка. */}
      <div css={{ display: 'flex', gap: theme.spacing.md, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div css={{ flex: '1 1 260px' }}>
          <Typography.Title level={2} css={{ marginBottom: theme.spacing.xs }}>
            ZALABench · Датасеты
          </Typography.Title>
          <Typography.Paragraph color="secondary" css={{ marginBottom: 0 }}>
            Реестр датасетов Inspect-JSON: сэмплы, каналы и предупреждения. Только просмотр. Данные — из сервиса
            zalabench-api.
          </Typography.Paragraph>
        </div>

        <div css={{ display: 'flex', gap: theme.spacing.sm, alignItems: 'center', flexWrap: 'wrap' }}>
          {isRefreshing && <Spinner size="small" />}
          <Button componentId="zala.datasets.refresh" onClick={() => refresh(false)} disabled={isLoading}>
            Обновить
          </Button>
        </div>
      </div>

      {/* E1: сервис недоступен. */}
      {isServiceDown && (
        <Alert
          componentId="zala.datasets.unavailable"
          type="error"
          message="Сервис недоступен"
          description={loadError?.message || `Проверьте, что zalabench-api запущен (${getApiBase()}).`}
          actions={[
            { componentId: 'zala.datasets.unavailable_retry', children: 'Повторить', onClick: () => refresh(true) },
          ]}
        />
      )}

      {/* Прочие ошибки загрузки списка. */}
      {loadError && !isServiceDown && (
        <Alert
          componentId="zala.datasets.load_error"
          type="error"
          message="Не удалось загрузить датасеты"
          description={loadError.message}
          actions={[{ componentId: 'zala.datasets.load_retry', children: 'Повторить', onClick: () => refresh(true) }]}
        />
      )}

      {selectedName === null ? (
        /* Список датасетов. */
        <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.sm }}>
          <div css={{ display: 'flex', gap: theme.spacing.sm, alignItems: 'baseline' }}>
            <Typography.Title level={4}>Датасеты</Typography.Title>
            <Typography.Text color="secondary">{datasets.length}</Typography.Text>
          </div>

          {isLoading ? (
            <div css={{ display: 'flex', gap: theme.spacing.sm, padding: theme.spacing.lg, alignItems: 'center' }}>
              <Spinner size="small" />
              <Typography.Text color="secondary">Загрузка датасетов…</Typography.Text>
            </div>
          ) : datasets.length === 0 ? (
            <Empty title="Датасетов нет" description="В каталоге data/ не найдено Inspect-JSON файлов." />
          ) : (
            <>
              <DatasetGroup
                title="Локальные датасеты"
                hint="Inspect-JSON из каталога data/"
                items={localDatasets}
                onOpen={openDataset}
              />
              <DatasetGroup
                title="Внешние датасеты"
                hint="inspect_evals: стратифицированные выборки MVP, данные грузятся из HF"
                items={externalDatasets}
                onOpen={openDataset}
              />
            </>
          )}
        </div>
      ) : (
        /* Детали выбранного датасета. */
        <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.md }}>
          <div css={{ display: 'flex', gap: theme.spacing.sm, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button componentId="zala.datasets.back" onClick={closeDetail}>
              ← К списку
            </Button>
            <Typography.Title level={4} css={{ marginBottom: 0 }}>
              {selectedName}
            </Typography.Title>
            {detail?.kind === 'external' && (
              <Tag componentId="zala.datasets.detail.kind_external" color="lemon">
                HF · {detail.channels ? Object.keys(detail.channels).join(', ') : 'external'}
              </Tag>
            )}
            {detailLoading && <Spinner size="small" />}
          </div>

          {/* E2: датасет не найден (404). */}
          {detailError && (
            <Alert
              componentId="zala.datasets.not_found"
              type="error"
              message={detailError.notFound ? 'Датасет не найден' : 'Не удалось загрузить датасет'}
              description={detailError.message}
              actions={[{ componentId: 'zala.datasets.not_found_back', children: 'К списку', onClick: closeDetail }]}
            />
          )}

          {/* E3: битый JSON — детали показывают ошибку реестра. */}
          {!detailError && detailBroken && (
            <Alert
              componentId="zala.datasets.broken"
              type="error"
              message="Датасет не читается"
              description={detailWarnings.join('; ')}
              actions={[{ componentId: 'zala.datasets.broken_back', children: 'К списку', onClick: closeDetail }]}
            />
          )}

          {/* HF недоступен: детали отдаются без сэмплов (Ф5 §10.3). */}
          {!detailError && detail?.kind === 'external' && detailWarnings.length > 0 && (
            <Alert
              componentId="zala.datasets.hf_warning"
              type="warning"
              message="Внешний датасет"
              description={detailWarnings.join('; ')}
            />
          )}

          {/* E6: каналы с недостатком сэмплов. */}
          {!detailError && detail && <SmallChannelAlert channels={detail.channels} />}

          {/* Сводка: hash, сэмплы, путь, обновлён. */}
          {detail && (
            <div
              css={{
                display: 'flex',
                gap: theme.spacing.lg,
                flexWrap: 'wrap',
                padding: theme.spacing.md,
                border: `1px solid ${theme.colors.border}`,
                borderRadius: theme.general.borderRadiusBase,
              }}
            >
              <div>
                <Typography.Text color="secondary">snapshot_hash</Typography.Text>
                <div>
                  <code>{detail.snapshotHash}</code>
                </div>
              </div>
              <div>
                <Typography.Text color="secondary">Сэмплов</Typography.Text>
                <div>{detail.samples}</div>
              </div>
              <div>
                <Typography.Text color="secondary">Обновлён</Typography.Text>
                <div>{formatDate(detail.updatedAt)}</div>
              </div>
              {detail.revision && (
                <div css={{ maxWidth: 280 }}>
                  <Typography.Text color="secondary">Ревизия HF</Typography.Text>
                  <div>
                    <code>{detail.revision}</code>
                  </div>
                </div>
              )}
              <div css={{ flex: '1 1 240px', minWidth: 0 }}>
                <Typography.Text color="secondary">Путь</Typography.Text>
                <div>
                  <Typography.Text>{detail.path}</Typography.Text>
                </div>
              </div>
              <div css={{ flex: '2 1 320px', minWidth: 0 }}>
                <Typography.Text color="secondary">Каналы</Typography.Text>
                <div css={{ marginTop: 4 }}>
                  <ChannelBadges channels={detail.channels} />
                </div>
              </div>
            </div>
          )}

          {/* Версии: API истории не отдаёт (E5). */}
          {detail && (
            <div
              css={{
                padding: theme.spacing.md,
                border: `1px dashed ${theme.colors.border}`,
                borderRadius: theme.general.borderRadiusBase,
              }}
            >
              <Typography.Title level={5} css={{ marginTop: 0, marginBottom: theme.spacing.xs }}>
                Версии
              </Typography.Title>
              <Typography.Text color="secondary">
                Текущий snapshot_hash: <code>{detail.snapshotHash}</code>
              </Typography.Text>
              <div>
                <Typography.Text color="secondary">
                  История версий — из git, в UI не реализована (API отдаёт только текущий hash). Смотрите{' '}
                  <code>git log --format=%h %cI -- {detail.path}</code>.
                </Typography.Text>
              </div>
            </div>
          )}

          {/* Сэмплы + фильтр по каналу. */}
          {detail && !detailBroken && (
            <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.sm }}>
              <div css={{ display: 'flex', gap: theme.spacing.sm, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <Typography.Title level={4} css={{ marginBottom: 0 }}>
                  Сэмплы
                </Typography.Title>
                <Typography.Text color="secondary">
                  {filteredSamples.length}
                  {channelFilter !== 'all' ? ` из ${detail.samplesList.length}` : ''}
                </Typography.Text>
                <Typography.Text color="secondary" css={{ fontSize: 12 }}>
                  Клик по строке открывает полный input и target.
                </Typography.Text>
                <div css={{ minWidth: 220 }}>
                  <Typography.Text color="secondary">Канал</Typography.Text>
                  <SimpleSelect
                    id="zala-datasets-channel"
                    componentId="zala.datasets.channel_filter"
                    value={channelFilter}
                    onChange={({ target }) => {
                      setChannelFilter(target.value);
                      setPage(0);
                    }}
                  >
                    {channelOptions.map((channel) => (
                      <SimpleSelectOption key={channel} value={channel}>
                        {channel === 'all' ? 'Все каналы' : channel}
                      </SimpleSelectOption>
                    ))}
                  </SimpleSelect>
                </div>
              </div>

              {detail.samplesTruncated && (
                <Alert
                  componentId="zala.datasets.samples_truncated"
                  type="info"
                  message="Показаны первые сэмплы"
                  description={`Внешний датасет: показаны первые ${detail.samplesList.length} сэмплов из ${detail.samples} в выборке MVP. Полный датасет загружается из HF при прогоне.`}
                />
              )}

              {visibleSamples.length === 0 ? (
                <Empty
                  title="Сэмплов нет"
                  description={
                    detail.kind === 'external'
                      ? 'Не удалось загрузить сэмплы из HF (см. предупреждения выше).'
                      : 'В выбранном канале нет сэмплов.'
                  }
                />
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
                    <TableHeader componentId="zala.datasets.sample_id_header" css={{ flex: 0.8 }}>
                      id
                    </TableHeader>
                    <TableHeader componentId="zala.datasets.sample_input_header" css={{ flex: 4 }}>
                      input
                    </TableHeader>
                    <TableHeader componentId="zala.datasets.sample_target_header" css={{ flex: 2 }}>
                      target
                    </TableHeader>
                    <TableHeader componentId="zala.datasets.sample_task_header" css={{ flex: 1.2 }}>
                      task_type
                    </TableHeader>
                  </TableRow>
                  {visibleSamples.map((sample) => (
                    <TableRow
                      key={sample.id}
                      css={{ cursor: 'pointer' }}
                      onClick={() => setActiveSample(sample)}
                      aria-label={`Открыть сэмпл ${sample.id}`}
                    >
                      <TableCell css={{ flex: 0.8 }}>
                        <code>{sample.id}</code>
                      </TableCell>
                      <TableCell css={{ flex: 4 }}>
                        <span title={sample.input}>{truncate(sample.input, INPUT_PREVIEW_CHARS)}</span>
                      </TableCell>
                      <TableCell css={{ flex: 2 }}>{truncate(sample.target, INPUT_PREVIEW_CHARS)}</TableCell>
                      <TableCell css={{ flex: 1.2 }}>
                        {sample.taskType ? (
                          <Tag componentId="zala.datasets.sample_task">{sample.taskType}</Tag>
                        ) : (
                          <Tag componentId="zala.datasets.sample_task.unknown" color="coral">
                            unknown
                          </Tag>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </Table>
              )}

              {/* E4: пагинация по 100. */}
              {isPaged && (
                <div css={{ display: 'flex', gap: theme.spacing.sm, alignItems: 'center' }}>
                  <Button
                    componentId="zala.datasets.page_prev"
                    onClick={() => setPage((value) => Math.max(value - 1, 0))}
                    disabled={currentPage === 0}
                  >
                    Назад
                  </Button>
                  <Typography.Text color="secondary">
                    Страница {currentPage + 1} из {pageCount}
                  </Typography.Text>
                  <Button
                    componentId="zala.datasets.page_next"
                    onClick={() => setPage((value) => Math.min(value + 1, pageCount - 1))}
                    disabled={currentPage >= pageCount - 1}
                  >
                    Вперёд
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Тикет #9: полный сэмпл в модалке (Esc и клик вне окна — штатное закрытие Modal). */}
      <SampleModal
        sample={activeSample}
        truncated={Boolean(detail?.samplesTruncated)}
        onClose={() => setActiveSample(null)}
      />
    </div>
  );
};

export default DatasetsPage;

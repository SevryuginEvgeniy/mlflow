/**
 * ZALABench — вкладка планировщика (Ф4.2).
 *
 * Очередь job'ов, постановка нового прогона, оценка длительности и действия
 * cancel/retry. Данные — из нашего сервиса `zalabench-api` (FastAPI),
 * не из MLflow REST (см. docs/UI-FORK.md).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Empty,
  Input,
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

import type { ZalaEstimate, ZalaJob } from './jobsApi';
import { ZalaApiError, apiHealth, cancelJob, createJob, estimateJob, listJobs, listModels, listTasks, retryJob } from './jobsApi';

/** Ключ sessionStorage с Bearer-токеном сервиса. */
const TOKEN_STORAGE_KEY = 'zala.apiToken';

/** Период автообновления очереди, мс. */
const POLL_INTERVAL_MS = 5000;

/** Задержка debounce для оценки длительности, мс. */
const ESTIMATE_DEBOUNCE_MS = 500;

/** Датасет по умолчанию (как в JobCreate). */
const DEFAULT_DATASET = 'Various eval';

/** Бейдж статуса job'а. */
const StatusBadge = ({ status }: { status: string }) => {
  const color =
    status === 'running'
      ? 'indigo'
      : status === 'done'
        ? 'lime'
        : status === 'failed'
          ? 'coral'
          : status === 'pending'
            ? 'lemon'
            : 'default';
  return (
    <Tag componentId="zala.jobs.status" color={color}>
      {status}
    </Tag>
  );
};

/** Компактная дата-время либо прочерк. */
const formatDate = (value: string | null): string => (value ? new Date(value).toLocaleString() : '—');

/** Длительность прогона: finished - started; для running — до текущего момента. */
const formatDuration = (startedAt: string | null, finishedAt: string | null): string => {
  if (!startedAt) {
    return '—';
  }
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const ms = end - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) {
    return '—';
  }
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}ч ${minutes}м`;
  }
  if (minutes > 0) {
    return `${minutes}м ${seconds}с`;
  }
  return `${seconds}с`;
};

/** Прошедшее время от старта job'а в человекочитаемом виде. */
const formatElapsed = (startedAt: string | null): string => {
  if (!startedAt) {
    return '—';
  }
  const ms = Date.now() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) {
    return '—';
  }
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes} мин ${seconds} с` : `${seconds} с`;
};

/** Читает токен из sessionStorage (может быть недоступен). */
const readToken = (): string => {
  try {
    return sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
};

/** Сохраняет токен в sessionStorage (может быть недоступен). */
const writeToken = (value: string): void => {
  try {
    if (value) {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, value);
    } else {
      sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // sessionStorage недоступен — токен останется только в состоянии страницы.
  }
};

/** Текст ошибки для показа пользователю. */
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const JobsPage = () => {
  const { theme } = useDesignSystemTheme();

  const [jobs, setJobs] = useState<ZalaJob[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<{ message: string; offline: boolean } | null>(null);

  const [healthStatus, setHealthStatus] = useState<string>('unknown');
  const [healthError, setHealthError] = useState<string | null>(null);

  const [token, setToken] = useState<string>(() => readToken());
  const [tokenError, setTokenError] = useState<string | null>(null);

  // Форма постановки.
  const [taskOptions, setTaskOptions] = useState<string[]>([]);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [tasks, setTasks] = useState<string[]>([]);
  const [model, setModel] = useState<string>('');
  const [dataset, setDataset] = useState<string>(DEFAULT_DATASET);
  const [seed, setSeed] = useState<string>('42');
  const [epochs, setEpochs] = useState<string>('1');
  const [scheduledAt, setScheduledAt] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitNotice, setSubmitNotice] = useState<string | null>(null);

  // Оценка длительности.
  const [estimate, setEstimate] = useState<ZalaEstimate | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);

  // Действия над строкой очереди.
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingJobId, setPendingJobId] = useState<string | null>(null);

  // Защита от наложения запросов polling'а.
  const inFlight = useRef(false);

  /** Загружает очередь и состояние сервиса; `initial` включает большой Spinner. */
  const refresh = useCallback(async (initial = false) => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    if (initial) {
      setIsLoading(true);
    } else {
      setIsRefreshing(true);
    }

    // Health и очередь независимы: health может ответить 503 (status=down).
    const healthPromise = apiHealth()
      .then((result) => {
        setHealthStatus(result.status);
        setHealthError(null);
      })
      .catch((e: unknown) => {
        setHealthStatus('down');
        setHealthError(errorText(e));
      });

    try {
      const result = await listJobs({ limit: 100 });
      setJobs(result.jobs);
      setTotal(result.total);
      setLoadError(null);
    } catch (e: unknown) {
      const offline = e instanceof ZalaApiError && e.status === 0;
      setLoadError({ message: errorText(e), offline });
      if (offline) {
        setJobs([]);
      }
    } finally {
      inFlight.current = false;
      setIsLoading(false);
      setIsRefreshing(false);
    }

    await healthPromise;
  }, []);

  // Опции формы: таски и модели из сервиса (не хардкод).
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [taskList, modelList] = await Promise.all([listTasks(), listModels()]);
        if (cancelled) return;
        setTaskOptions(taskList);
        setModelOptions(modelList);
        if (taskList.length > 0 && tasks.length === 0) setTasks([taskList[0]]);
        if (modelList.length > 0 && !model) setModel(modelList[0]);
      } catch {
        // Опции не критичны: форма покажет пустые списки.
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Первичная загрузка + автообновление раз в 5 с.
  useEffect(() => {
    refresh(true);
    const timer = window.setInterval(() => {
      refresh(false);
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // E-оценка: debounce 500 мс при изменении task/model.
  useEffect(() => {
    let cancelled = false;
    setEstimate(null);
    setEstimateError(null);
    const timer = window.setTimeout(() => {
      estimateJob(tasks[0] ?? '', model)
        .then((result) => {
          if (!cancelled) {
            setEstimate(result);
          }
        })
        .catch((e: unknown) => {
          if (!cancelled) {
            setEstimateError(errorText(e));
          }
        });
    }, ESTIMATE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [tasks, model]);

  const onTokenChange = useCallback((value: string) => {
    setToken(value);
    writeToken(value);
    setTokenError(null);
    setSubmitError(null);
    setActionError(null);
  }, []);

  /** Общая обработка ошибок управляющих запросов: 401 и 409 (E2/E4). */
  const handleActionError = useCallback((e: unknown) => {
    if (e instanceof ZalaApiError && e.status === 401) {
      setTokenError('неверный токен');
      return;
    }
    setActionError(errorText(e));
  }, []);

  const onSubmit = useCallback(async () => {
    if (!token) {
      setTokenError('введите токен');
      return;
    }
    const seedValue = Number(seed);
    const epochsValue = Number(epochs);
    if (!Number.isInteger(seedValue)) {
      setSubmitError('seed: ожидалось целое число');
      return;
    }
    if (!Number.isInteger(epochsValue) || epochsValue < 1) {
      setSubmitError('epochs: ожидалось целое число >= 1');
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);
    setSubmitNotice(null);
    setTokenError(null);
    try {
      const created: string[] = [];
      for (const taskName of tasks) {
        const job = await createJob(
          {
            task: taskName,
            model,
            dataset: dataset.trim() || DEFAULT_DATASET,
            seed: seedValue,
            epochs: epochsValue,
            scheduledAt: scheduledAt || undefined,
          },
          token,
        );
        created.push(job.jobId.slice(0, 8));
      }
      setSubmitNotice(
        created.length === 1
          ? `Job ${created[0]} поставлен в очередь.`
          : `Поставлено задач: ${created.length} (${created.join(', ')}).`,
      );
      await refresh(false);
    } catch (e: unknown) {
      if (e instanceof ZalaApiError && e.status === 401) {
        setTokenError('неверный токен');
      } else {
        setSubmitError(errorText(e));
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [token, seed, epochs, tasks, model, dataset, scheduledAt, refresh]);

  const onCancel = useCallback(
    async (jobId: string) => {
      setPendingJobId(jobId);
      setActionError(null);
      setTokenError(null);
      try {
        await cancelJob(jobId, token);
        await refresh(false);
      } catch (e: unknown) {
        handleActionError(e);
      } finally {
        setPendingJobId(null);
      }
    },
    [token, refresh, handleActionError],
  );

  const onRetry = useCallback(
    async (jobId: string) => {
      setPendingJobId(jobId);
      setActionError(null);
      setTokenError(null);
      try {
        await retryJob(jobId, token);
        await refresh(false);
      } catch (e: unknown) {
        handleActionError(e);
      } finally {
        setPendingJobId(null);
      }
    },
    [token, refresh, handleActionError],
  );

  /** E1: сервис недоступен (сетевая ошибка) — отдельный Alert с повтором. */
  const isServiceDown = Boolean(loadError?.offline) || (healthStatus === 'down' && Boolean(healthError));
  const hasToken = token.trim().length > 0;

  const healthColor = useMemo(() => {
    if (healthStatus === 'ok') {
      return 'lime';
    }
    if (healthStatus === 'degraded') {
      return 'lemon';
    }
    if (healthStatus === 'down') {
      return 'coral';
    }
    return 'default';
  }, [healthStatus]);

  const estimateText = estimate
    ? `≈ ${Number(estimate.minutes.toFixed(2))} мин (${estimate.source === 'history' ? 'история' : 'оценка'})`
    : null;

  return (
    <div css={{ padding: theme.spacing.lg, display: 'flex', flexDirection: 'column', gap: theme.spacing.lg }}>
      {/* Шапка: заголовок, статус API, токен, обновление. */}
      <div css={{ display: 'flex', gap: theme.spacing.md, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div css={{ flex: '1 1 260px' }}>
          <Typography.Title level={2} css={{ marginBottom: theme.spacing.xs }}>
            ZALABench · Планировщик
          </Typography.Title>
          <Typography.Paragraph color="secondary" css={{ marginBottom: 0 }}>
            Очередь прогонов, постановка задач и оценка длительности. Данные — из сервиса zalabench-api.
          </Typography.Paragraph>
        </div>

        <div css={{ display: 'flex', gap: theme.spacing.sm, alignItems: 'center', flexWrap: 'wrap' }}>
          <Tag componentId="zala.jobs.health" color={healthColor}>
            API: {healthStatus}
          </Tag>
          {isRefreshing && <Spinner size="small" />}
          <Button componentId="zala.jobs.refresh" onClick={() => refresh(false)} disabled={isLoading}>
            Обновить
          </Button>
        </div>

        <div css={{ flex: '1 1 320px', minWidth: 240 }}>
          <Typography.Text color="secondary">Токен сервиса (только для POST)</Typography.Text>
          <Input
            componentId="zala.jobs.token"
            type="password"
            value={token}
            onChange={(e) => onTokenChange(e.target.value)}
            placeholder="Bearer-токен zalabench-api"
            validationState={tokenError ? 'error' : undefined}
            autoComplete="off"
          />
          {tokenError && (
            <Typography.Text color="error" css={{ display: 'block', marginTop: theme.spacing.xs }}>
              {tokenError}
            </Typography.Text>
          )}
        </div>
      </div>

      {/* E1: сервис недоступен. */}
      {isServiceDown && (
        <Alert
          componentId="zala.jobs.unavailable"
          type="error"
          message="Сервис недоступен"
          description={loadError?.message || healthError || 'Проверьте, что zalabench-api запущен на 127.0.0.1:8000.'}
          actions={[
            { componentId: 'zala.jobs.unavailable_retry', children: 'Повторить', onClick: () => refresh(true) },
          ]}
        />
      )}

      {/* Прочие ошибки загрузки очереди. */}
      {loadError && !isServiceDown && (
        <Alert
          componentId="zala.jobs.load_error"
          type="error"
          message="Не удалось загрузить очередь"
          description={loadError.message}
          actions={[{ componentId: 'zala.jobs.load_retry', children: 'Повторить', onClick: () => refresh(true) }]}
        />
      )}

      {/* E4: ошибка действия (409 и прочие). */}
      {actionError && (
        <Alert
          componentId="zala.jobs.action_error"
          type="error"
          message="Действие не выполнено"
          description={actionError}
          closable
          onClose={() => setActionError(null)}
        />
      )}

      <div css={{ display: 'flex', gap: theme.spacing.lg, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* Очередь. */}
        <div css={{ flex: '1 1 640px', minWidth: 0 }}>
          <div css={{ display: 'flex', gap: theme.spacing.sm, alignItems: 'baseline' }}>
            <Typography.Title level={4}>Очередь</Typography.Title>
            <Typography.Text color="secondary">
              {jobs.length} из {total}
            </Typography.Text>
          </div>

          {isLoading ? (
            /* E5: долгая загрузка — Spinner, остальной UI не блокируется. */
            <div css={{ display: 'flex', gap: theme.spacing.sm, padding: theme.spacing.lg, alignItems: 'center' }}>
              <Spinner size="small" />
              <Typography.Text color="secondary">Загрузка очереди…</Typography.Text>
            </div>
          ) : jobs.length === 0 ? (
            /* E3: пустая очередь. */
            <Empty
              title="Очередь пуста"
              description="Поставьте задачу в форме справа — она появится здесь."
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
                <TableHeader componentId="zala.jobs.id_header" css={{ flex: 1 }}>
                  Job
                </TableHeader>
                <TableHeader componentId="zala.jobs.task_header" css={{ flex: 1.5 }}>
                  Task
                </TableHeader>
                <TableHeader componentId="zala.jobs.model_header" css={{ flex: 1.5 }}>
                  Модель
                </TableHeader>
                <TableHeader componentId="zala.jobs.status_header" css={{ flex: 1 }}>
                  Статус
                </TableHeader>
                <TableHeader componentId="zala.jobs.scheduled_header" css={{ flex: 1.6 }}>
                  Отложенный запуск
                </TableHeader>
                <TableHeader componentId="zala.jobs.created_header" css={{ flex: 1.6 }}>
                  Создан
                </TableHeader>
                <TableHeader componentId="zala.jobs.started_header" css={{ flex: 1.6 }}>
                  Начат
                </TableHeader>
                <TableHeader componentId="zala.jobs.duration_header" css={{ flex: 1 }}>
                  Длительность
                </TableHeader>
                <TableHeader componentId="zala.jobs.attempts_header" css={{ flex: 0.8 }}>
                  Попытки
                </TableHeader>
                <TableHeader componentId="zala.jobs.progress_header" css={{ flex: 1.6 }}>
                  Прогресс
                </TableHeader>
                <TableHeader componentId="zala.jobs.error_header" css={{ flex: 2 }}>
                  Ошибка
                </TableHeader>
                <TableHeader componentId="zala.jobs.actions_header" css={{ flex: 1.6 }}>
                  Действия
                </TableHeader>
              </TableRow>
              {jobs.map((job) => {
                const isPending = pendingJobId === job.jobId;
                return (
                  <TableRow key={job.jobId}>
                    <TableCell css={{ flex: 1 }}>
                      <code>{job.jobId.slice(0, 8)}</code>
                    </TableCell>
                    <TableCell css={{ flex: 1.5 }}>{job.taskName}</TableCell>
                    <TableCell css={{ flex: 1.5 }}>{job.model}</TableCell>
                    <TableCell css={{ flex: 1 }}>
                      <StatusBadge status={job.status} />
                    </TableCell>
                    <TableCell css={{ flex: 1.6 }}>{formatDate(job.scheduledAt)}</TableCell>
                    <TableCell css={{ flex: 1.6 }}>{formatDate(job.createdAt)}</TableCell>
                    <TableCell css={{ flex: 1.6 }}>{formatDate(job.startedAt)}</TableCell>
                    <TableCell css={{ flex: 1 }}>{formatDuration(job.startedAt, job.finishedAt)}</TableCell>
                    <TableCell css={{ flex: 0.8 }}>{job.attempts}</TableCell>
                    <TableCell css={{ flex: 1.6 }}>
                      {job.status === 'running'
                        ? `${job.progressDone}/${job.progressTotal ?? '?'} · ${formatElapsed(job.startedAt)}`
                        : '—'}
                    </TableCell>
                    <TableCell css={{ flex: 2 }}>
                      {job.error ? (
                        <Typography.Text color="error">{job.error}</Typography.Text>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell css={{ flex: 1.6 }}>
                      {job.status === 'pending' && (
                        <Button
                          componentId="zala.jobs.cancel"
                          onClick={() => onCancel(job.jobId)}
                          disabled={!hasToken || isPending}
                        >
                          {isPending ? 'Отмена…' : 'Отменить'}
                        </Button>
                      )}
                      {job.status === 'failed' && (
                        <Button
                          componentId="zala.jobs.retry"
                          onClick={() => onRetry(job.jobId)}
                          disabled={!hasToken || isPending}
                        >
                          {isPending ? 'Повтор…' : 'Повторить'}
                        </Button>
                      )}
                      {job.status !== 'pending' && job.status !== 'failed' && '—'}
                    </TableCell>
                  </TableRow>
                );
              })}
            </Table>
          )}
        </div>

        {/* Постановка задачи. */}
        <div
          css={{
            flex: '1 1 320px',
            minWidth: 280,
            display: 'flex',
            flexDirection: 'column',
            gap: theme.spacing.sm,
            padding: theme.spacing.md,
            border: `1px solid ${theme.colors.border}`,
            borderRadius: theme.general.borderRadiusBase,
          }}
        >
          <Typography.Title level={4} css={{ marginBottom: 0 }}>
            Новая задача
          </Typography.Title>

          <div>
            <Typography.Text color="secondary">Задачи</Typography.Text>
            <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.xs }}>
              {taskOptions.map((option) => (
                <Checkbox
                  key={option}
                  componentId={`zala.jobs.form.task.${option}`}
                  isChecked={tasks.includes(option)}
                  onChange={(checked) =>
                    setTasks((prev) =>
                      checked ? [...prev, option] : prev.filter((t) => t !== option),
                    )
                  }
                >
                  {option}
                </Checkbox>
              ))}
            </div>
          </div>

          <div>
            <Typography.Text color="secondary">Модель</Typography.Text>
            <SimpleSelect
              id="zala-jobs-model"
              componentId="zala.jobs.form.model"
              value={model}
              onChange={({ target }) => setModel(target.value)}
            >
              {modelOptions.map((option) => (
                <SimpleSelectOption key={option} value={option}>
                  {option}
                </SimpleSelectOption>
              ))}
            </SimpleSelect>
          </div>

          <div>
            <Typography.Text color="secondary">Оценка длительности</Typography.Text>
            <div>
              {estimateError ? (
                <Typography.Text color="error">оценка недоступна</Typography.Text>
              ) : estimateText ? (
                <Typography.Text>{estimateText}</Typography.Text>
              ) : (
                <Typography.Text color="secondary">…</Typography.Text>
              )}
            </div>
          </div>

          <div>
            <Typography.Text color="secondary">Датасет</Typography.Text>
            <Input
              componentId="zala.jobs.form.dataset"
              value={dataset}
              onChange={(e) => setDataset(e.target.value)}
              placeholder={DEFAULT_DATASET}
            />
          </div>

          <div css={{ display: 'flex', gap: theme.spacing.sm }}>
            <div css={{ flex: 1 }}>
              <Typography.Text color="secondary">Seed</Typography.Text>
              <Input
                componentId="zala.jobs.form.seed"
                type="number"
                value={seed}
                onChange={(e) => setSeed(e.target.value)}
              />
            </div>
            <div css={{ flex: 1 }}>
              <Typography.Text color="secondary">Эпохи</Typography.Text>
              <Input
                componentId="zala.jobs.form.epochs"
                type="number"
                min={1}
                value={epochs}
                onChange={(e) => setEpochs(e.target.value)}
              />
            </div>
          </div>

          <div>
            <Typography.Text color="secondary">Время запуска (опционально)</Typography.Text>
            <Input
              componentId="zala.jobs.form.scheduled_at"
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
            />
          </div>

          {submitError && (
            <Alert componentId="zala.jobs.submit_error" type="error" message="Задача не создана" description={submitError} />
          )}
          {submitNotice && (
            <Alert componentId="zala.jobs.submit_notice" type="success" message={submitNotice} closable onClose={() => setSubmitNotice(null)} />
          )}

          <Button
            componentId="zala.jobs.submit"
            type="primary"
            onClick={onSubmit}
            disabled={!hasToken || isSubmitting}
          >
            {isSubmitting ? 'Постановка…' : 'Поставить в очередь'}
          </Button>
          {!hasToken && (
            <Typography.Text color="secondary">Введите токен в шапке — без него постановка и действия недоступны.</Typography.Text>
          )}
        </div>
      </div>
    </div>
  );
};

export default JobsPage;

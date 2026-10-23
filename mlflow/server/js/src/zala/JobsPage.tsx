/**
 * ZALABench — вкладка планировщика (Ф4.2).
 *
 * Очередь job'ов, постановка нового прогона, оценка длительности и действия
 * cancel/retry. Данные — из нашего сервиса `zalabench-api` (FastAPI),
 * не из MLflow REST (см. docs/UI-FORK.md).
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

import type { ZalaDatasetSummary } from './datasetsApi';
import { listDatasets } from './datasetsApi';
import type { ZalaEstimate, ZalaJob } from './jobsApi';
import {
  ZalaApiError,
  apiHealth,
  cancelJob,
  clearQueue,
  createGroupJobs,
  createJob,
  deleteJob,
  estimateJob,
  getApiBase,
  createExperiment,
  listExperiments,
  listJobs,
  listModels,
  listTasks,
  retryJob,
} from './jobsApi';

/** Ключ sessionStorage с Bearer-токеном сервиса. */
const TOKEN_STORAGE_KEY = 'zala.apiToken';

/** Период автообновления очереди, мс. */
const POLL_INTERVAL_MS = 5000;

/** Задержка debounce для оценки длительности, мс. */
const ESTIMATE_DEBOUNCE_MS = 500;

/** Датасет по умолчанию (как в JobCreate). */
const DEFAULT_DATASET = 'Various eval';

/** MLflow-эксперимент по умолчанию (как в JobCreate). */
const DEFAULT_EXPERIMENT = 'zalabench';

/** Значение селекта «создать новый эксперимент». */
const NEW_EXPERIMENT_VALUE = '__new__';

/**
 * Уровни reasoning (Ф5.1). `auto` — не передавать: Inspect такого уровня не
 * знает; `minimal` сервис принимает, но в UI не показываем.
 */
const REASONING_EFFORT_OPTIONS = ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Бейдж статуса job'а. */
/** Статусы, строку которых можно удалить из очереди (Ф5 §8.1). */
const DELETABLE_STATUSES = ['pending', 'failed', 'done', 'cancelled', 'partial'];

/** Русские подписи статусов; неизвестный статус показываем как есть. */
const STATUS_LABELS: Record<string, string> = {
  pending: 'pending',
  running: 'running',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
  partial: 'partial',
};

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
            : status === 'cancelled'
              ? 'charcoal'
              : status === 'partial'
                ? 'turquoise'
                : 'default';
  return (
    <Tag componentId="zala.jobs.status" color={color}>
      {STATUS_LABELS[status] ?? status}
    </Tag>
  );
};

/**
 * Ф5.8 M3: дата и время по отдельности — колонка узкая, однострочное
 * «дд.мм.гггг, чч:мм:сс» обрезалось до даты. Ячейка показывает дату крупно,
 * время второй строкой мелким шрифтом.
 */
const formatDateParts = (value: string | null): { date: string; time: string } => {
  if (!value) {
    return { date: '—', time: '' };
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { date: '—', time: '' };
  }
  return {
    date: date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }),
    time: date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  };
};

/** Ф5.8 M3: ячейка даты/времени в две строки — дата сверху, время снизу мелким. */
const DateTimeCell = ({ value }: { value: string | null }) => {
  const { theme } = useDesignSystemTheme();
  const parts = formatDateParts(value);
  if (!parts.time) {
    return <span>{parts.date}</span>;
  }
  return (
    <div css={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
      <span>{parts.date}</span>
      <span css={{ fontSize: theme.typography.fontSizeSm, color: theme.colors.textSecondary }}>{parts.time}</span>
    </div>
  );
};

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
  const [model, setModel] = useState<string>('');
  // Датасеты реестра (GET /datasets): не хардкод — локальные + внешние.
  const [datasetOptions, setDatasetOptions] = useState<ZalaDatasetSummary[]>([]);
  // Тикет #8: единый список выбора — датасеты реестра и служебные таски
  // (hello, agent_*) в одном наборе. Один элемент -> одна задача; два и
  // больше внешних датасетов -> составной прогон с общим group_id.
  const [selection, setSelection] = useState<string[]>([]);
  const [experimentOptions, setExperimentOptions] = useState<string[]>([DEFAULT_EXPERIMENT]);
  const [experiment, setExperiment] = useState<string>(DEFAULT_EXPERIMENT);
  const [newExperiment, setNewExperiment] = useState<string>('');
  const [seed, setSeed] = useState<string>('42');
  const [epochs, setEpochs] = useState<string>('1');
  const [scheduledAt, setScheduledAt] = useState<string>('');
  // Ф5.8e: приоритет очереди, watchdog (минуты в UI, секунды в API) и роли.
  const [priority, setPriority] = useState<string>('0');
  const [timeLimitMinutes, setTimeLimitMinutes] = useState<string>('');
  // Тикет #16: роли из реестра датасетов — только те, что нужны выбранным.
  const [modelRoles, setModelRoles] = useState<Record<string, string>>({});
  // Ф5.8e: раскрытые строки таблицы (роли моделей не влезают в 12 колонок).
  const [expandedJobIds, setExpandedJobIds] = useState<string[]>([]);

  // Ф5.1: ручки генерации. Основные — всегда на виду, расширенные — свёрнуты.
  const [temperature, setTemperature] = useState<string>('0');
  const [maxTokens, setMaxTokens] = useState<string>('');
  const [reasoningEffort, setReasoningEffort] = useState<string>('auto');
  const [systemPrompt, setSystemPrompt] = useState<string>('');
  const [topP, setTopP] = useState<string>('');
  const [topK, setTopK] = useState<string>('');
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(false);
  // Тикет #8: единый список — внешние датасеты реестра и служебные таски.
  // Локальный dev-датасет (various_eval_dev) — не отдельный пункт: он
  // подставляется датасетом для служебных тасков (песочница для smoke).
  const externalDatasets = useMemo(
    () => datasetOptions.filter((item) => item.kind === 'external'),
    [datasetOptions],
  );
  const localDataset = useMemo(
    () => datasetOptions.find((item) => item.kind === 'local')?.name ?? DEFAULT_DATASET,
    [datasetOptions],
  );
  const serviceTasks = useMemo(
    () => taskOptions.filter((name) => !datasetOptions.some((item) => item.name === name)),
    [taskOptions, datasetOptions],
  );
  const selectedExternalDatasets = useMemo(
    () => selection.filter((name) => externalDatasets.some((item) => item.name === name)),
    [selection, externalDatasets],
  );
  const selectedServiceTasks = useMemo(
    () => selection.filter((name) => serviceTasks.includes(name)),
    [selection, serviceTasks],
  );
  // Составной прогон — только внешние датасеты (локальный таска не задаёт).
  const isGroupRun = selectedExternalDatasets.length >= 2;
  // Внешний датасет: system prompt вшит в inspect_evals (Ф5.1).
  const isExternalDataset = selectedExternalDatasets.length > 0;
  // Тикет #16: роли — объединение ролей выбранных датасетов (роль -> описание).
  const availableRoles = useMemo(() => {
    const roles: Record<string, string> = {};
    for (const name of selectedExternalDatasets) {
      const item = externalDatasets.find((option) => option.name === name);
      for (const [role, description] of Object.entries(item?.roles ?? {})) {
        if (!(role in roles)) {
          roles[role] = description;
        }
      }
    }
    return roles;
  }, [selectedExternalDatasets, externalDatasets]);
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
        const [taskList, modelList, datasetList, experimentList] = await Promise.all([
          listTasks(),
          listModels(),
          listDatasets(),
          listExperiments().catch(() => []),
        ]);
        if (cancelled) return;
        setTaskOptions(taskList);
        setModelOptions(modelList);
        setDatasetOptions(datasetList);
        // Ф5.6: эксперименты — из сервиса; дефолт остаётся zalabench.
        setExperimentOptions(
          experimentList.length > 0 ? experimentList.map((item) => item.name) : [DEFAULT_EXPERIMENT],
        );
        if (modelList.length > 0 && !model) setModel(modelList[0]);
        // Тикет #8: по умолчанию выбран первый внешний датасет реестра
        // (локальный dev — не отдельный пункт, он подставляется служебным).
        setSelection((prev) => {
          if (prev.length > 0) return prev;
          const firstExternal = datasetList.find((item) => item.kind === 'external');
          return firstExternal ? [firstExternal.name] : [];
        });
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

  // E-оценка: debounce 500 мс при изменении выбора/модели. Для внешнего
  // датасета task = имя датасета; для служебных — сам таск на локальном.
  useEffect(() => {
    let cancelled = false;
    setEstimate(null);
    setEstimateError(null);
    const estimateTask =
      selectedExternalDatasets[0] ?? selectedServiceTasks[0] ?? serviceTasks[0] ?? '';
    const estimateDataset = selectedExternalDatasets[0] ?? localDataset;
    const timer = window.setTimeout(() => {
      estimateJob(estimateTask, model, undefined, estimateDataset)
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
  }, [selectedExternalDatasets, selectedServiceTasks, serviceTasks, localDataset, model]);

  /**
   * Тикет #8: единый выбор. Внешние датасеты можно отмечать несколько —
   * 2+ дадут составной прогон; служебные таски в него не входят и ставятся
   * отдельными задачами. Внутри одной группы отметки складываются.
   */
  const onSelectionToggle = useCallback((name: string, checked: boolean) => {
    setSubmitError(null);
    setSubmitNotice(null);
    setSelection((prev) =>
      checked ? (prev.includes(name) ? prev : [...prev, name]) : prev.filter((item) => item !== name),
    );
  }, []);

  // Тикет #16: смена датасета убирает роли, которых у него нет (иначе в
  // запрос ушла бы роль, которую датасет не использует).
  useEffect(() => {
    setModelRoles((prev) => {
      const next: Record<string, string> = {};
      for (const role of Object.keys(availableRoles)) {
        if (prev[role]) next[role] = prev[role];
      }
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [availableRoles]);

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
    // Ф5.8e: приоритет 0..10 и лимит времени в минутах (в API — секунды).
    const priorityValue = priority.trim() === '' ? 0 : Number(priority);
    if (!Number.isInteger(priorityValue) || priorityValue < 0 || priorityValue > 10) {
      setSubmitError('приоритет: целое 0..10');
      return;
    }
    let timeLimitS: number | undefined;
    if (timeLimitMinutes.trim() !== '') {
      const minutesValue = Number(timeLimitMinutes);
      if (!Number.isInteger(minutesValue) || minutesValue < 1) {
        setSubmitError('лимит времени: пусто (без лимита) или целое >= 1 мин');
        return;
      }
      timeLimitS = minutesValue * 60;
    }
    // Тикет #16: шлём только роли, которые нужны выбранным датасетам.
    const roles: Record<string, string> = {};
    for (const role of Object.keys(availableRoles)) {
      const value = modelRoles[role];
      if (value) roles[role] = value;
    }
    // Тикет #8: без выбора ставить нечего.
    if (selection.length === 0) {
      setSubmitError('выберите датасет или служебный таск');
      return;
    }
    // Ф5.1: ручки генерации — проверяем диапазоны до отправки (сервис тоже
    // вернёт 422, но здесь сообщение понятнее и без похода в сеть).
    const knobs: Record<string, unknown> = {};
    const temperatureValue = Number(temperature);
    if (temperature.trim() === '' || !Number.isFinite(temperatureValue)) {
      setSubmitError('temperature: ожидалось число');
      return;
    }
    if (temperatureValue < 0 || temperatureValue > 2) {
      setSubmitError('temperature: диапазон 0.0–2.0');
      return;
    }
    knobs['temperature'] = temperatureValue;
    if (maxTokens.trim() !== '') {
      const value = Number(maxTokens);
      if (!Number.isInteger(value) || value < 1) {
        setSubmitError('max_tokens: пусто (без лимита) или целое >= 1');
        return;
      }
      knobs['max_tokens'] = value;
    }
    if (reasoningEffort !== 'auto') {
      knobs['reasoning_effort'] = reasoningEffort;
    }
    if (systemPrompt.trim()) {
      knobs['system_prompt'] = systemPrompt.trim();
    }
    if (topP.trim() !== '') {
      const value = Number(topP);
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        setSubmitError('top_p: диапазон 0.0–1.0');
        return;
      }
      knobs['top_p'] = value;
    }
    if (topK.trim() !== '') {
      const value = Number(topK);
      if (!Number.isInteger(value) || value < 0) {
        setSubmitError('top_k: целое >= 0');
        return;
      }
      knobs['top_k'] = value;
    }

    setIsSubmitting(true);
    setSubmitError(null);
    setSubmitNotice(null);
    setTokenError(null);
    try {
      // Ф5.6: выбранный эксперимент; «новый» -> создаём перед постановкой.
      let experimentName = experiment;
      if (experiment === NEW_EXPERIMENT_VALUE) {
        const name = newExperiment.trim();
        if (!name) {
          setSubmitError('имя нового эксперимента: пусто');
          setIsSubmitting(false);
          return;
        }
        const createdExperiment = await createExperiment(name, token);
        experimentName = createdExperiment.name;
        setExperimentOptions((prev) => (prev.includes(name) ? prev : [...prev, name]));
        setExperiment(name);
        setNewExperiment('');
      }

      const created: string[] = [];
      // Внешние датасеты: 1 -> одна задача, 2+ -> составной прогон с общим
      // group_id (task определяется сервисом по имени датасета; system_prompt
      // у внешних вшит в inspect_evals и не передаётся).
      if (isGroupRun) {
        const groupKnobs = { ...knobs };
        delete groupKnobs['system_prompt'];
        const group = await createGroupJobs(
          {
            datasets: selectedExternalDatasets,
            model,
            seed: seedValue,
            epochs: epochsValue,
            scheduledAt: scheduledAt || undefined,
            experiment: experimentName,
            knobs: groupKnobs,
            priority: priorityValue,
            timeLimitS,
            modelRoles: roles,
          },
          token,
        );
        group.jobs.forEach((job) => created.push(job.jobId.slice(0, 8)));
        setSubmitNotice(
          `Составной прогон ${group.groupId.slice(0, 8)}: задач ${created.length} (${created.join(', ')}).`,
        );
      } else if (selectedExternalDatasets.length === 1) {
        const name = selectedExternalDatasets[0];
        // system_prompt у внешних датасетов вшит в inspect_evals — не шлём.
        const externalKnobs = { ...knobs };
        delete externalKnobs['system_prompt'];
        const job = await createJob(
          {
            task: name,
            dataset: name,
            model,
            seed: seedValue,
            epochs: epochsValue,
            scheduledAt: scheduledAt || undefined,
            experiment: experimentName,
            knobs: externalKnobs,
            priority: priorityValue,
            timeLimitS,
            modelRoles: roles,
          },
          token,
        );
        created.push(job.jobId.slice(0, 8));
        setSubmitNotice(`Job ${created[0]} поставлен в очередь.`);
      }
      // Служебные таски — всегда отдельные задачи на локальном датасете,
      // в составной прогон не входят.
      for (const taskName of selectedServiceTasks) {
        const job = await createJob(
          {
            task: taskName,
            dataset: localDataset,
            model,
            seed: seedValue,
            epochs: epochsValue,
            scheduledAt: scheduledAt || undefined,
            experiment: experimentName,
            knobs,
            priority: priorityValue,
            timeLimitS,
            // Роли — только у внешних датасетов (у служебных тасков их нет).
            modelRoles: {},
          },
          token,
        );
        created.push(job.jobId.slice(0, 8));
        if (!isGroupRun && selectedExternalDatasets.length === 0) {
          setSubmitNotice(
            selectedServiceTasks.length === 1
              ? `Job ${created[created.length - 1]} поставлен в очередь.`
              : `Поставлено задач: ${created.length} (${created.join(', ')}).`,
          );
        }
      }
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
  }, [
    token,
    seed,
    epochs,
    selection,
    model,
    selectedExternalDatasets,
    selectedServiceTasks,
    isGroupRun,
    localDataset,
    availableRoles,
    modelRoles,
    scheduledAt,
    experiment,
    newExperiment,
    temperature,
    maxTokens,
    reasoningEffort,
    systemPrompt,
    topP,
    topK,
    priority,
    timeLimitMinutes,
    refresh,
  ]);

  const onCancel = useCallback(
    async (jobId: string) => {
      // Ф5 §8.3: отмена running необратима — подтверждаем.
      if (!window.confirm(`Отменить задачу ${jobId.slice(0, 8)}? Прогон будет прерван.`)) {
        return;
      }
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

  const onDelete = useCallback(
    async (jobId: string) => {
      if (!window.confirm(`Удалить задачу ${jobId.slice(0, 8)} из очереди? Run и лог останутся.`)) {
        return;
      }
      setPendingJobId(jobId);
      setActionError(null);
      setTokenError(null);
      try {
        await deleteJob(jobId, token);
        await refresh(false);
      } catch (e: unknown) {
        handleActionError(e);
      } finally {
        setPendingJobId(null);
      }
    },
    [token, refresh, handleActionError],
  );

  const onClearQueue = useCallback(async () => {
    if (!window.confirm('Удалить ВСЕ ожидающие задачи из очереди? Run и логи останутся.')) {
      return;
    }
    setActionError(null);
    setTokenError(null);
    try {
      const { deleted } = await clearQueue('pending', token);
      setSubmitNotice(`Удалено из очереди: ${deleted}`);
      await refresh(false);
    } catch (e: unknown) {
      handleActionError(e);
    }
  }, [token, refresh, handleActionError]);

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
          description={loadError?.message || healthError || `Проверьте, что zalabench-api запущен (${getApiBase()}).`}
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
          <div css={{ display: 'flex', gap: theme.spacing.sm, alignItems: 'center' }}>
            <Typography.Title level={4} css={{ marginBottom: 0 }}>
              Очередь
            </Typography.Title>
            <Typography.Text color="secondary">
              {jobs.length} из {total}
            </Typography.Text>
            {/* Ф5 §8.3: массовая очистка ожидающих задач. */}
            <div css={{ marginLeft: 'auto' }}>
              <Button
                componentId="zala.jobs.clear_queue"
                onClick={onClearQueue}
                disabled={!hasToken || pendingJobId !== null || jobs.every((job) => job.status !== 'pending')}
              >
                Очистить очередь
              </Button>
            </div>
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
                <TableHeader componentId="zala.jobs.experiment_header" css={{ flex: 1.2 }}>
                  Эксперимент
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
                <TableHeader componentId="zala.jobs.priority_header" css={{ flex: 0.8 }}>
                  Приоритет
                </TableHeader>
                <TableHeader componentId="zala.jobs.time_limit_header" css={{ flex: 0.9 }}>
                  Лимит
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
                const isExpanded = expandedJobIds.includes(job.jobId);
                const roleEntries = Object.entries(job.modelRoles || {});
                return (
                  <Fragment key={job.jobId}>
                  <TableRow>
                    <TableCell css={{ flex: 1 }}>
                      <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.xs }}>
                        <div css={{ display: 'flex', alignItems: 'center', gap: theme.spacing.xs }}>
                          {/* Ф5.8e: раскрытие строки — роли моделей. */}
                          <Button
                            componentId="zala.jobs.expand"
                            type="tertiary"
                            onClick={() =>
                              setExpandedJobIds((prev) =>
                                prev.includes(job.jobId)
                                  ? prev.filter((id) => id !== job.jobId)
                                  : [...prev, job.jobId],
                              )
                            }
                          >
                            {isExpanded ? '▾' : '▸'}
                          </Button>
                          <code>{job.jobId.slice(0, 8)}</code>
                        </div>
                        {/* Ф5.2: бейдж «группа» у задач составного прогона. */}
                        {job.groupId && (
                          <Tag componentId="zala.jobs.group_badge" color="indigo" title={job.groupId}>
                            группа {job.groupId.slice(0, 8)}
                          </Tag>
                        )}
                      </div>
                    </TableCell>
                    <TableCell css={{ flex: 1.5 }}>{job.taskName}</TableCell>
                    <TableCell css={{ flex: 1.5 }}>{job.model}</TableCell>
                    <TableCell css={{ flex: 1.2 }}>{job.experiment}</TableCell>
                    <TableCell css={{ flex: 1 }}>
                      <StatusBadge status={job.status} />
                    </TableCell>
                    <TableCell css={{ flex: 1.6 }}>
                      <DateTimeCell value={job.scheduledAt} />
                    </TableCell>
                    <TableCell css={{ flex: 1.6 }}>
                      <DateTimeCell value={job.createdAt} />
                    </TableCell>
                    <TableCell css={{ flex: 1.6 }}>
                      <DateTimeCell value={job.startedAt} />
                    </TableCell>
                    <TableCell css={{ flex: 1 }}>{formatDuration(job.startedAt, job.finishedAt)}</TableCell>
                    <TableCell css={{ flex: 0.8 }}>{job.attempts}</TableCell>
                    <TableCell css={{ flex: 0.8 }}>{job.priority}</TableCell>
                    <TableCell css={{ flex: 0.9 }}>
                      {job.timeLimitS != null ? `${Math.round(job.timeLimitS / 60)} мин` : '—'}
                    </TableCell>
                    <TableCell css={{ flex: 1.6 }}>
                      {job.status === 'running'
                        ? `${job.progressDone}/${job.progressTotal ?? '?'} · ${formatElapsed(job.startedAt)}`
                        : job.status === 'partial'
                          ? job.progressTotal != null
                            ? `${job.progressDone} из ${job.progressTotal} сэмплов, прервано`
                            : 'прервано'
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
                      <div css={{ display: 'flex', gap: theme.spacing.xs, flexWrap: 'wrap' }}>
                        {/* Ф5 §8.3: отмена доступна и для running (кооперативно). */}
                        {(job.status === 'pending' || job.status === 'running') && (
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
                        {/* Ф5 §8.3: удаление строки (run и лог остаются). */}
                        {DELETABLE_STATUSES.includes(job.status) && (
                          <Button
                            componentId="zala.jobs.delete"
                            onClick={() => onDelete(job.jobId)}
                            disabled={!hasToken || isPending}
                          >
                            {isPending ? 'Удаление…' : 'Удалить'}
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                  {/* Ф5.8e: раскрытие строки — роли моделей (не влезают в колонки). */}
                  {isExpanded && (
                    <TableRow>
                      <TableCell css={{ flex: 1 }} multiline>
                        {roleEntries.length === 0 ? (
                          <Typography.Text color="secondary">
                            Роли не заданы — Inspect подставит модель прогона.
                          </Typography.Text>
                        ) : (
                          <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.xs }}>
                            {roleEntries.map(([role, roleModel]) => (
                              <Typography.Text key={role} css={{ fontSize: 12 }}>
                                {role} → {roleModel}
                              </Typography.Text>
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
            <Typography.Text color="secondary">Датасеты</Typography.Text>
            <Typography.Paragraph color="secondary" css={{ fontSize: 12, marginBottom: theme.spacing.xs }}>
              Один датасет — одна задача; два и более — составной прогон с общим group_id.
            </Typography.Paragraph>
            <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.xs }}>
              {externalDatasets.length === 0 ? (
                <Typography.Text color="secondary" css={{ fontSize: 12 }}>
                  Внешних датасетов в реестре нет.
                </Typography.Text>
              ) : (
                externalDatasets.map((item) => (
                  <Checkbox
                    key={item.name}
                    componentId="zala.jobs.form.dataset"
                    isChecked={selection.includes(item.name)}
                    onChange={(checked) => onSelectionToggle(item.name, checked)}
                  >
                    {item.name} · {item.samples} сэмплов
                  </Checkbox>
                ))
              )}
            </div>
          </div>

          <div>
            <Typography.Text color="secondary">Служебные</Typography.Text>
            <Typography.Paragraph color="secondary" css={{ fontSize: 12, marginBottom: theme.spacing.xs }}>
              Свои таски на локальном датасете ({localDataset}); в составной прогон не входят.
            </Typography.Paragraph>
            <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.xs }}>
              {serviceTasks.length === 0 ? (
                <Typography.Text color="secondary" css={{ fontSize: 12 }}>
                  Служебных тасков нет.
                </Typography.Text>
              ) : (
                serviceTasks.map((option) => (
                  <Checkbox
                    key={option}
                    componentId="zala.jobs.form.task"
                    isChecked={selection.includes(option)}
                    onChange={(checked) => onSelectionToggle(option, checked)}
                  >
                    {option}
                  </Checkbox>
                ))
              )}
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
            <Typography.Text color="secondary">Эксперимент</Typography.Text>
            <SimpleSelect
              id="zala-jobs-experiment"
              componentId="zala.jobs.form.experiment"
              value={experiment}
              onChange={({ target }) => setExperiment(target.value)}
            >
              {experimentOptions.map((option) => (
                <SimpleSelectOption key={option} value={option}>
                  {option}
                </SimpleSelectOption>
              ))}
              <SimpleSelectOption value={NEW_EXPERIMENT_VALUE}>Создать новый…</SimpleSelectOption>
            </SimpleSelect>
            {experiment === NEW_EXPERIMENT_VALUE && (
              <Input
                componentId="zala.jobs.form.experiment_new"
                value={newExperiment}
                onChange={(e) => setNewExperiment(e.target.value)}
                placeholder="имя нового эксперимента"
                validationState={newExperiment.includes('/') ? 'error' : undefined}
              />
            )}
          </div>

          {selection.length > 0 && (
            <Typography.Text color="secondary" css={{ fontSize: 12 }}>
              {[
                isGroupRun
                  ? `Составной прогон: ${selectedExternalDatasets.length} задач с общим group_id (${selectedExternalDatasets.join(', ')}).`
                  : selectedExternalDatasets.length === 1
                    ? `Датасет: ${selectedExternalDatasets[0]}.`
                    : null,
                selectedServiceTasks.length > 0
                  ? `Служебные: ${selectedServiceTasks.length} отдельных задач (${selectedServiceTasks.join(', ')}).`
                  : null,
              ]
                .filter(Boolean)
                .join(' ')}
            </Typography.Text>
          )}

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

          {/* Ф5.1: параметры генерации — основные ручки. */}
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
            <Typography.Title level={5} css={{ margin: 0 }}>
              Параметры генерации
            </Typography.Title>
            <div css={{ display: 'flex', gap: theme.spacing.sm }}>
              <div css={{ flex: 1 }}>
                <Typography.Text color="secondary">Temperature (0.0–2.0)</Typography.Text>
                <Input
                  componentId="zala.jobs.form.temperature"
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={temperature}
                  onChange={(e) => setTemperature(e.target.value)}
                />
              </div>
              <div css={{ flex: 1 }}>
                <Typography.Text color="secondary">Max tokens (пусто — без лимита)</Typography.Text>
                <Input
                  componentId="zala.jobs.form.max_tokens"
                  type="number"
                  min={1}
                  value={maxTokens}
                  placeholder="без лимита"
                  onChange={(e) => setMaxTokens(e.target.value)}
                />
              </div>
            </div>
            <div>
              <Typography.Text color="secondary">Уровень reasoning (thinking)</Typography.Text>
              <SimpleSelect
                id="zala-jobs-reasoning-effort"
                componentId="zala.jobs.form.reasoning_effort"
                value={reasoningEffort}
                onChange={({ target }) => setReasoningEffort(target.value)}
              >
                {REASONING_EFFORT_OPTIONS.map((option) => (
                  <SimpleSelectOption key={option} value={option}>
                    {option}
                  </SimpleSelectOption>
                ))}
              </SimpleSelect>
              {model === 'DS-CLUSTER' && (
                <Typography.Text color="secondary" css={{ fontSize: 12 }}>
                  Уровень слабо влияет на DS-CLUSTER: модель почти не меняет глубину
                  рассуждений между none и max.
                </Typography.Text>
              )}
            </div>
            <div>
              <Typography.Text color="secondary">
                System prompt (только для своих тасков)
              </Typography.Text>
              <Input.TextArea
                componentId="zala.jobs.form.system_prompt"
                value={systemPrompt}
                placeholder="Пусто — системный промпт таска по умолчанию"
                rows={3}
                onChange={(e) => setSystemPrompt(e.target.value)}
              />
              {isExternalDataset && (
                <Typography.Text color="secondary" css={{ fontSize: 12 }}>
                  Для внешнего датасета system prompt вшит в inspect_evals — поле
                  будет отклонено сервисом (422).
                </Typography.Text>
              )}
            </div>

            {/* Расширенные ручки — свёрнуты, чтобы не перегружать форму. */}
            <div>
              <Typography.Link
                componentId="zala.jobs.form.advanced_toggle"
                onClick={() => setAdvancedOpen((prev) => !prev)}
              >
                {advancedOpen ? 'Скрыть расширенные' : 'Расширенные параметры'}
              </Typography.Link>
              {advancedOpen && (
                <div css={{ display: 'flex', gap: theme.spacing.sm, marginTop: theme.spacing.sm }}>
                  <div css={{ flex: 1 }}>
                    <Typography.Text color="secondary">top_p (0.0–1.0)</Typography.Text>
                    <Input
                      componentId="zala.jobs.form.top_p"
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={topP}
                      placeholder="по умолчанию"
                      onChange={(e) => setTopP(e.target.value)}
                    />
                  </div>
                  <div css={{ flex: 1 }}>
                    <Typography.Text color="secondary">top_k (≥ 0)</Typography.Text>
                    <Input
                      componentId="zala.jobs.form.top_k"
                      type="number"
                      min={0}
                      value={topK}
                      placeholder="по умолчанию"
                      onChange={(e) => setTopK(e.target.value)}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Ф5.8e: приоритет и watchdog — параметры очереди, не генерации. */}
          <div css={{ display: 'flex', gap: theme.spacing.sm }}>
            <div css={{ flex: 1 }}>
              <Typography.Text color="secondary">Приоритет (0–10)</Typography.Text>
              <Input
                componentId="zala.jobs.form.priority"
                type="number"
                min={0}
                max={10}
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              />
              <Typography.Text color="secondary" css={{ fontSize: 12 }}>
                Больше = раньше в очереди.
              </Typography.Text>
            </div>
            <div css={{ flex: 1 }}>
              <Typography.Text color="secondary">Лимит времени, мин (пусто — без лимита)</Typography.Text>
              <Input
                componentId="zala.jobs.form.time_limit_minutes"
                type="number"
                min={1}
                value={timeLimitMinutes}
                placeholder="без лимита"
                onChange={(e) => setTimeLimitMinutes(e.target.value)}
              />
              <Typography.Text color="secondary" css={{ fontSize: 12 }}>
                По истечении задача прерывается.
              </Typography.Text>
            </div>
          </div>

          {/* Тикет #16: роли — только те, что нужны выбранным датасетам. */}
          {Object.keys(availableRoles).length > 0 && (
            <div>
              <Typography.Text color="secondary">Роли моделей</Typography.Text>
              <Typography.Paragraph color="secondary" css={{ fontSize: 12, marginBottom: theme.spacing.xs }}>
                Пусто = Inspect подставит модель прогона (GLM будет судить GLM).
              </Typography.Paragraph>
              <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.xs }}>
                {Object.entries(availableRoles).map(([role, description]) => (
                  <div key={role} css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.xs }}>
                    <div css={{ display: 'flex', alignItems: 'center', gap: theme.spacing.sm }}>
                      <Typography.Text css={{ width: 60 }}>{role}</Typography.Text>
                      <div css={{ flex: 1 }}>
                        <SimpleSelect
                          id={`zala-jobs-role-${role}`}
                          componentId="zala.jobs.form.model_role"
                          value={modelRoles[role] ?? ''}
                          onChange={({ target }) =>
                            setModelRoles((prev) => ({ ...prev, [role]: target.value }))
                          }
                        >
                          <SimpleSelectOption value="">— не задана —</SimpleSelectOption>
                          {modelOptions.map((option) => (
                            <SimpleSelectOption key={option} value={option}>
                              {option}
                            </SimpleSelectOption>
                          ))}
                        </SimpleSelect>
                      </div>
                    </div>
                    <Typography.Text color="secondary" css={{ fontSize: 12 }}>
                      {description}
                    </Typography.Text>
                  </div>
                ))}
              </div>
            </div>
          )}

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

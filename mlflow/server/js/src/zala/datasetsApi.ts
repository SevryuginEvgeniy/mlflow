/**
 * ZALABench — клиент сервиса `zalabench-api` для вкладки датасетов (Ф4.4).
 *
 * Реестр датасетов живёт в нашем сервисе (FastAPI, `GET /datasets`), MLflow
 * о нём не знает. Всё чтение — без токена (read-only).
 *
 * Базовый URL и класс ошибки переиспользуются из `jobsApi.ts`, чтобы не
 * плодить второй источник правды.
 */
import { ZalaApiError, getApiBase } from './jobsApi';

/** Краткое описание датасета (DatasetSummary из zalabench-api). */
export interface ZalaDatasetSummary {
  name: string;
  path: string;
  snapshotHash: string;
  samples: number;
  channels: Record<string, number>;
  updatedAt: string;
  warnings: string[];
}

/** Сэмпл датасета (SampleOut из zalabench-api). */
export interface ZalaSample {
  id: string;
  input: string;
  target: string;
  taskType: string | null;
}

/** Детали датасета: summary + список сэмплов. */
export interface ZalaDatasetDetail extends ZalaDatasetSummary {
  samplesList: ZalaSample[];
}

/** Строка DatasetSummary в ответе сервиса (snake_case). */
interface RawDatasetSummary {
  name: string;
  path: string;
  snapshot_hash: string;
  samples: number;
  channels: Record<string, number>;
  updated_at: string;
  warnings?: string[];
}

/** Строка SampleOut в ответе сервиса (snake_case). */
interface RawSample {
  id: string;
  input: string;
  target: string;
  task_type: string | null;
}

/** Детали в ответе сервиса (snake_case). */
interface RawDatasetDetail extends RawDatasetSummary {
  samples_list?: RawSample[];
}

/** snake_case -> camelCase (summary). */
const toDatasetSummary = (raw: RawDatasetSummary): ZalaDatasetSummary => ({
  name: raw.name,
  path: raw.path,
  snapshotHash: raw.snapshot_hash,
  samples: raw.samples,
  channels: raw.channels ?? {},
  updatedAt: raw.updated_at,
  warnings: raw.warnings ?? [],
});

/** snake_case -> camelCase (sample). */
const toSample = (raw: RawSample): ZalaSample => ({
  id: raw.id,
  input: raw.input,
  target: raw.target,
  taskType: raw.task_type,
});

/**
 * Запрос к сервису с единым форматом ошибок.
 *
 * Сетевая ошибка -> `ZalaApiError(status=0)` — страница показывает E1.
 */
const request = async <T>(path: string): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(`${getApiBase()}${path}`);
  } catch (e) {
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

/**
 * Имя датасета -> безопасный путь.
 *
 * Имя может быть относительным путём (`sub/name`), поэтому кодируем каждый
 * сегмент отдельно: `encodeURIComponent` целиком превратил бы `/` в `%2F`
 * и маршрут `/datasets/{name:path}` его не поймал бы.
 */
const encodeDatasetName = (name: string): string => name.split('/').map(encodeURIComponent).join('/');

/** Все датасеты реестра. */
export const listDatasets = async (): Promise<ZalaDatasetSummary[]> => {
  const payload = await request<{ datasets?: RawDatasetSummary[] }>('/datasets');
  return (payload.datasets ?? []).map(toDatasetSummary);
};

/** Детали одного датасета; 404 -> ZalaApiError(status=404) (E2). */
export const getDataset = async (name: string): Promise<ZalaDatasetDetail> => {
  const raw = await request<RawDatasetDetail>(`/datasets/${encodeDatasetName(name)}`);
  return {
    ...toDatasetSummary(raw),
    samplesList: (raw.samples_list ?? []).map(toSample),
  };
};

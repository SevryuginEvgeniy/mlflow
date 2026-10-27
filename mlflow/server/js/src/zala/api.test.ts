/**
 * Регрессия: NaN-метрика роняла вкладку ZALA белым экраном.
 *
 * MLflow хранит `NaN`/`Infinity` в БД, но в JSON их нет — сервер отдаёт их
 * строкой (`"NaN"`). Страница звала `value.toFixed(4)` и падала с
 * `TypeError: e.toFixed is not a function`. Проверяем, что разбор ответа
 * приводит значения к числам, а `NaN` не превращается в мусор.
 */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

import { searchZalaRuns } from './api';

const mockFetch = (payload: unknown) => {
  global.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  })) as unknown as typeof fetch;
};

describe('searchZalaRuns: значения метрик', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('строковый "NaN" от сервера не роняет разбор и остаётся NaN', async () => {
    mockFetch({
      runs: [
        {
          info: { run_id: 'r1', run_name: 'calc', status: 'FINISHED', start_time: 1 },
          data: {
            metrics: [
              { key: 'zala.math_calc.accuracy', value: 1 },
              { key: 'zala.math_calc.tool_overuse_rate_hard', value: 'NaN' },
            ],
            params: [],
            tags: [],
          },
        },
      ],
    });

    const page = await searchZalaRuns(['1']);
    const metrics = page.runs[0].metrics;

    expect(metrics['zala.math_calc.accuracy']).toBe(1);
    // Метрика существует, но значение не вычислилось — UI покажет прочерк.
    expect(metrics['zala.math_calc.tool_overuse_rate_hard']).toBeNaN();
    // Главное: это число, а не строка — иначе `toFixed` падает.
    expect(typeof metrics['zala.math_calc.tool_overuse_rate_hard']).toBe('number');
  });

  it('числовые строки приводятся к числу', async () => {
    mockFetch({
      runs: [
        {
          info: { run_id: 'r2', run_name: 'calc', status: 'FINISHED', start_time: 1 },
          data: { metrics: [{ key: 'zala.math_calc.accuracy', value: '0.75' }], params: [], tags: [] },
        },
      ],
    });

    const page = await searchZalaRuns(['1']);
    expect(page.runs[0].metrics['zala.math_calc.accuracy']).toBe(0.75);
  });

  it('"Infinity" и мусорная строка не попадают в метрики', async () => {
    mockFetch({
      runs: [
        {
          info: { run_id: 'r3', run_name: 'calc', status: 'FINISHED', start_time: 1 },
          data: {
            metrics: [
              { key: 'zala.math_calc.inf', value: 'Infinity' },
              { key: 'zala.math_calc.junk', value: 'n/a' },
              { key: 'zala.math_calc.accuracy', value: 0.5 },
            ],
            params: [],
            tags: [],
          },
        },
      ],
    });

    const page = await searchZalaRuns(['1']);
    const metrics = page.runs[0].metrics;

    expect(metrics['zala.math_calc.inf']).toBe(Infinity);
    expect(metrics['zala.math_calc.junk']).toBeUndefined();
    expect(metrics['zala.math_calc.accuracy']).toBe(0.5);
  });
});

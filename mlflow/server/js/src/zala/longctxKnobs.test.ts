/**
 * W5C §11.2 — условные поля longctx_stress в форме планировщика (E-case V8-UI).
 *
 * Проверка спеки `docs/specs/longctx-stress.md` §11.2: пять ручек
 * (ctx_min/ctx_max/turn_min/turn_max/duration_min) видны ТОЛЬКО когда выбран
 * датасет `longctx_stress` (или его таск, элемент выбора `"датасет::таск"`).
 * Пустое значение = не передаём (канон limit/max_samples). min/max — числа,
 * min <= max.
 */
import { describe, it, expect } from '@jest/globals';

import {
  buildLongctxKnobs,
  isLongctxSelected,
} from './longctxKnobs';

describe('isLongctxSelected (поля видны только для longctx_stress)', () => {
  it('поля скрыты для не-longctx датасета', () => {
    expect(isLongctxSelected([])).toBe(false);
    expect(isLongctxSelected(['math_tooluse::math_calc'])).toBe(false);
    expect(isLongctxSelected(['Various eval'])).toBe(false);
    expect(isLongctxSelected(['HLE', 'SimpleQA'])).toBe(false);
  });

  it('поля видны для таска longctx_stress ("датасет::таск")', () => {
    expect(isLongctxSelected(['longctx_stress::longctx_oneshot'])).toBe(true);
    expect(
      isLongctxSelected([
        'math_tooluse::math_calc',
        'longctx_stress::longctx_multiturn',
      ]),
    ).toBe(true);
  });

  it('поля видны для самого датасета longctx_stress', () => {
    expect(isLongctxSelected(['longctx_stress'])).toBe(true);
  });

  it('похожее имя датасета не считается longctx', () => {
    expect(isLongctxSelected(['longctx_stress_v2::x'])).toBe(false);
  });
});

describe('buildLongctxKnobs (пустое = не передаём, канон limit)', () => {
  it('пустые значения не попадают в knobs', () => {
    const { knobs, error } = buildLongctxKnobs({
      ctxMin: '',
      ctxMax: '',
      turnMin: '',
      turnMax: '',
      durationMin: '',
    });
    expect(error).toBeNull();
    expect(knobs).toEqual({});
  });

  it('заполненные значения попадают в knobs числами', () => {
    const { knobs, error } = buildLongctxKnobs({
      ctxMin: '50000',
      ctxMax: '300000',
      turnMin: '5000',
      turnMax: '50000',
      durationMin: '30',
    });
    expect(error).toBeNull();
    expect(knobs).toEqual({
      ctx_min: 50000,
      ctx_max: 300000,
      turn_min: 5000,
      turn_max: 50000,
      duration_min: 30,
    });
  });

  it('min > max — ошибка формы', () => {
    const { error } = buildLongctxKnobs({
      ctxMin: '300000',
      ctxMax: '50000',
      turnMin: '',
      turnMax: '',
      durationMin: '',
    });
    expect(error).toMatch(/Контекст/);
  });

  it('turn_min > turn_max — ошибка формы', () => {
    const { error } = buildLongctxKnobs({
      ctxMin: '',
      ctxMax: '',
      turnMin: '50000',
      turnMax: '5000',
      durationMin: '',
    });
    expect(error).toMatch(/Прирост хода/);
  });

  it('не-число — ошибка формы', () => {
    const { error } = buildLongctxKnobs({
      ctxMin: 'abc',
      ctxMax: '',
      turnMin: '',
      turnMax: '',
      durationMin: '',
    });
    expect(error).not.toBeNull();
  });

  it('частично заполненный диапазон допустим (только min)', () => {
    const { knobs, error } = buildLongctxKnobs({
      ctxMin: '10000',
      ctxMax: '',
      turnMin: '',
      turnMax: '',
      durationMin: '',
    });
    expect(error).toBeNull();
    expect(knobs).toEqual({ ctx_min: 10000 });
  });
});
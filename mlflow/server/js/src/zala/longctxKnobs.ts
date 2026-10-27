/**
 * W5C §11.2 — условные поля longctx_stress в форме планировщика.
 *
 * Спека `docs/specs/longctx-stress.md` §11.2: пять ручек стресс-теста
 * (`ctx_min`, `ctx_max`, `turn_min`, `turn_max`, `duration_min`) показываются
 * ТОЛЬКО когда выбран датасет `longctx_stress` или его таск (элемент выбора
 * планировщика — `"датасет::таск"`). Для остальных датасетов поля скрыты.
 *
 * Канон ручек (как limit/max_samples): пустое значение = не передаём;
 * min/max — числа, min <= max. Валидация — клиентская ошибка формы.
 *
 * Тесты: `longctxKnobs.test.ts` (E-case V8-UI).
 */

/** Датасет, для которого видны поля стресс-теста. */
export const LONGCTX_DATASET = 'longctx_stress';

/**
 * Значения по умолчанию (спека §11.2) — показываются в полях, чтобы
 * пользователь видел, с каким профилем работает (B-92).
 */
export const LONGCTX_DEFAULTS = {
  ctxMin: 50000,
  ctxMax: 300000,
  turnMin: 5000,
  turnMax: 50000,
  durationMin: 30,
} as const;

/**
 * Выбран ли longctx_stress: элемент выбора — либо сам датасет, либо
 * `"датасет::таск"`. Похожие имена (`longctx_stress_v2::x`) не считаются.
 */
export function isLongctxSelected(selection: string[]): boolean {
  return selection.some((name) => {
    const [dataset] = name.split('::');
    return dataset === LONGCTX_DATASET;
  });
}

/** Значения пяти ручек longctx_stress из формы (строки, '' = не заполнено). */
export interface LongctxFields {
  ctxMin: string;
  ctxMax: string;
  turnMin: string;
  turnMax: string;
  durationMin: string;
}

/** Пара ручек min/max: ключи knobs и подпись для сообщения об ошибке. */
const RANGE_PAIRS: ReadonlyArray<{
  minKey: string;
  maxKey: string;
  label: string;
  fields: readonly [keyof LongctxFields, keyof LongctxFields];
}> = [
  {
    minKey: 'ctx_min',
    maxKey: 'ctx_max',
    label: 'Контекст',
    fields: ['ctxMin', 'ctxMax'],
  },
  {
    minKey: 'turn_min',
    maxKey: 'turn_max',
    label: 'Прирост хода',
    fields: ['turnMin', 'turnMax'],
  },
];

/**
 * Собрать ручки longctx_stress из значений формы.
 *
 * Пустое значение = ручка не передаётся (канон limit). Возвращает
 * `error` (текст ошибки формы) или `knobs` — только заполненные ручки
 * со значениями-числами.
 */
export function buildLongctxKnobs(fields: LongctxFields): {
  knobs: Record<string, number>;
  error: string | null;
} {
  const knobs: Record<string, number> = {};
  const parsed: Partial<Record<keyof LongctxFields, number>> = {};

  // Все пять ручек: целые >= 0 (duration_min >= 1 по спеке §11.2).
  const allFields: ReadonlyArray<[keyof LongctxFields, string, number]> = [
    ['ctxMin', 'ctx_min', 0],
    ['ctxMax', 'ctx_max', 0],
    ['turnMin', 'turn_min', 0],
    ['turnMax', 'turn_max', 0],
    ['durationMin', 'duration_min', 1],
  ];
  for (const [field, key, minValue] of allFields) {
    const raw = fields[field].trim();
    if (raw === '') continue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < minValue) {
      return {
        knobs: {},
        error: `${key}: пусто или целое >= ${minValue}`,
      };
    }
    parsed[field] = value;
    knobs[key] = value;
  }

  // Пары min/max: min <= max, если оба заполнены.
  for (const pair of RANGE_PAIRS) {
    const [minField, maxField] = pair.fields;
    const min = parsed[minField];
    const max = parsed[maxField];
    if (min !== undefined && max !== undefined && min > max) {
      return { knobs: {}, error: `${pair.label}: «от» не больше «до»` };
    }
  }

  return { knobs, error: null };
}
/**
 * 轻量 JSON Schema 校验器。
 *
 * 为什么不装 ajv：本产品的安全承诺之一是「依赖面尽量小」。
 * 400 行以内能覆盖我们需要的全部子集，就不引入一个几百 KB 的依赖。
 *
 * 支持：type / properties / required / items / enum / const / oneOf /
 *       additionalProperties / minLength / maxLength / minItems / maxItems /
 *       minimum / maximum / nullable(通过 type 数组表达)
 */

const typeOf = (v) => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
};

const matchesType = (v, t) => {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  if (t === 'integer') return actual === 'integer';
  return actual === t;
};

/**
 * @returns {Array<{path:string, message:string}>} 空数组表示校验通过
 */
export function validate(value, schema, path = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push({
        path,
        message: `类型应为 ${types.join('|')}，实际是 ${typeOf(value)}`,
      });
      return errors; // 类型都不对，继续深挖没意义
    }
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push({ path, message: `必须等于 ${JSON.stringify(schema.const)}` });
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((e) => e === value)) {
    errors.push({
      path,
      message: `取值必须是 ${schema.enum.map((e) => JSON.stringify(e)).join(' / ')} 之一，实际是 ${JSON.stringify(value)}`,
    });
  }

  if (Array.isArray(schema.oneOf)) {
    const ok = schema.oneOf.some((sub) => validate(value, sub, path).length === 0);
    if (!ok) errors.push({ path, message: '不满足 oneOf 中的任何一个分支' });
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path, message: `长度至少 ${schema.minLength}，实际 ${value.length}` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({ path, message: `长度最多 ${schema.maxLength}，实际 ${value.length}` });
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path, message: `最小 ${schema.minimum}，实际 ${value}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ path, message: `最大 ${schema.maximum}，实际 ${value}` });
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path, message: `至少 ${schema.minItems} 项，实际 ${value.length} 项` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({ path, message: `最多 ${schema.maxItems} 项，实际 ${value.length} 项` });
    }
    if (schema.items) {
      value.forEach((item, i) => {
        errors.push(...validate(item, schema.items, `${path}[${i}]`));
      });
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (value[key] === undefined || value[key] === null) {
        errors.push({ path: `${path}.${key}`, message: '缺少必填字段' });
      }
    }
    const props = schema.properties ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (value[key] !== undefined && value[key] !== null) {
        errors.push(...validate(value[key], sub, `${path}.${key}`));
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) {
          errors.push({ path: `${path}.${key}`, message: '不允许的额外字段' });
        }
      }
    }
  }

  return errors;
}

/** 便捷断言：失败时抛出可读错误 */
export function assertValid(value, schema, label = 'payload') {
  const errors = validate(value, schema);
  if (errors.length) {
    const msg = errors.map((e) => `${e.path}: ${e.message}`).join('; ');
    const err = new Error(`${label} 结构校验失败 → ${msg}`);
    err.code = 'SCHEMA_INVALID';
    err.details = errors;
    throw err;
  }
  return value;
}

/* ────────────────────────────────────────────────────────────────
 * 语义收敛（coercion）
 *
 * 为什么必须有这一层：实测 DeepSeek-V4.1-Flash 会把 confidence 字段
 * 写成 "0.95" 而不是 "high"。这属于**格式不听话，意思完全正确**。
 * 如果为此让整个任务失败，普通人看到的就是「莫名其妙失败了」。
 * 所以对语义无歧义的情况我们主动收敛，而不是苛求模型。
 *
 * 原则：只做**不改变原意**的转换。有歧义就交给 validate 报错。
 * ──────────────────────────────────────────────────────────────── */

/** 把 0..1 的小数或百分数映射到 low/medium/high */
export function mapConfidence(value) {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(n)) return null;
  const v = n > 1 ? n / 100 : n; // 95 → 0.95
  if (v >= 0.75) return 'high';
  if (v >= 0.45) return 'medium';
  return 'low';
}

/** 严重度同理：数字/其它写法 → high/medium/low */
export function mapSeverity(value) {
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (['high', 'medium', 'low'].includes(s)) return s;
    if (['critical', 'severe', 'blocker', 'fatal', '严重', '高'].includes(s)) return 'high';
    if (['major', 'moderate', 'warning', '中', '中等'].includes(s)) return 'medium';
    if (['minor', 'trivial', 'info', 'note', '低', '轻微'].includes(s)) return 'low';
    return mapConfidence(s);
  }
  return mapConfidence(value);
}

/**
 * 就地把 value 收敛成符合 schema 的形状。返回是否改动了内容。
 * 只在 schema 明确给出 enum / type 时动手，绝不猜。
 *
 * 对对象/数组递归进入，直接修改父容器的字段（这样原始值能被替换）。
 */
export function coerceInPlace(value, schema, state = { changed: false }) {
  if (!schema || typeof schema !== 'object' || value === null || value === undefined) {
    return state.changed;
  }
  const types =
    schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  const isStringType = types.includes('string');

  if (Array.isArray(schema.enum) && schema.enum.length && !schema.enum.some((e) => e === value)) {
    const normalized = normalizeEnum(value, schema.enum, isStringType);
    if (normalized !== NO_MATCH) return normalized;
  }

  // 递归：对象
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const props = schema.properties ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (value[key] === undefined || value[key] === null) continue;
      const fixed = coerceInPlace(value[key], sub, state);
      if (fixed !== false && fixed !== value[key]) {
        value[key] = fixed;
        state.changed = true;
      }
    }
  }

  // 递归：数组
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i += 1) {
      const fixed = coerceInPlace(value[i], schema.items, state);
      if (fixed !== false && fixed !== value[i]) {
        value[i] = fixed;
        state.changed = true;
      }
    }
  }

  return state.changed;
}

const NO_MATCH = Symbol('no-match');

/** 把一个不合规的值映射到 enum 里最接近的合法值 */
function normalizeEnum(value, enumValues, isStringType) {
  // 大小写不敏感直接命中
  if (isStringType && typeof value === 'string') {
    const lower = enumValues.find(
      (e) => typeof e === 'string' && e.toLowerCase() === value.trim().toLowerCase(),
    );
    if (lower !== undefined) return lower;
  }

  // 置信度 / 严重度语义映射（这是实测最常出问题的地方）
  const enumStrings = enumValues.filter((e) => typeof e === 'string');
  if (isStringType && enumStrings.some((e) => ['high', 'medium', 'low'].includes(e))) {
    const mapped = mapSeverity(value);
    if (mapped && enumValues.includes(mapped)) return mapped;
  }

  // 布尔 → 字符串枚举
  if (isStringType && typeof value === 'boolean') {
    const guess = value
      ? enumValues.find((e) => /^(true|yes|是)/i.test(String(e)))
      : enumValues.find((e) => /^(false|no|否)/i.test(String(e)));
    if (guess !== undefined) return guess;
  }

  // 数字 → 只要 enum 里只有数字，试着转
  if (typeof value === 'string' && enumValues.every((e) => typeof e === 'number')) {
    const n = Number(value);
    if (Number.isFinite(n) && enumValues.includes(n)) return n;
  }

  // 数字字符串 → 字符串枚举里的同名
  if (typeof value === 'number') {
    const asString = String(value);
    if (enumValues.includes(asString)) return asString;
  }

  return NO_MATCH;
}

/**
 * 把 schema 里所有 enum 约束渲染成一句人话，附在提示词后面。
 * 实测这比「请严格遵守 schema」有效得多 —— 模型对具体取值列表敏感。
 */
export function describeEnumConstraints(schema, path = '', out = []) {
  if (!schema || typeof schema !== 'object') return out;
  if (Array.isArray(schema.enum)) {
    out.push(`${path || '根'} 只能取：${schema.enum.map((e) => JSON.stringify(e)).join(' | ')}`);
  }
  const props = schema.properties ?? {};
  for (const [key, sub] of Object.entries(props)) {
    describeEnumConstraints(sub, path ? `${path}.${key}` : key, out);
  }
  if (schema.items) describeEnumConstraints(schema.items, `${path}[]`, out);
  return out;
}


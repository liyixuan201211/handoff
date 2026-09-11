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
 * 哨兵：表示「这个值没什么可收敛的」。
 *
 * ⚠️ 历史 bug 记录（QA 工程师实测发现，务必不要重犯）：
 * 早先版本这里返回布尔 `changed`，而调用方把返回值当作「替换值」赋回父容器，
 * 结果**整个 artifacts 数组被 `true` 覆盖**，一份好好的交付物直接变成
 * 「类型应为 array，实际是 boolean」。
 * 教训：一个函数的返回值只能有**一种含义**。「是否需要替换」用 changed 引用参数传出，
 * 返回值只表示「替换成什么」。
 */
const NO_MATCH = Symbol('no-match');

/**
 * 就地把 value 收敛成符合 schema 的形状。
 *
 * 语义（唯一约定）：
 *  - 返回值 === NO_MATCH → 无需替换，保留原值
 *  - 返回值 !== NO_MATCH → 用返回值替换原值
 *  - `changed` 是纯输出参数，记录是否发生过任何替换
 *
 * 只在 schema 明确给出 enum / type 时动手，绝不猜。
 */
export function coerceInPlace(value, schema, changed = { value: false }) {
  if (!schema || typeof schema !== 'object' || value === null || value === undefined) {
    return NO_MATCH;
  }
  const types =
    schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  const isStringType = types.includes('string');

  // 1) 当前值本身就能被收敛（枚举语义映射）
  const hasEnum = Array.isArray(schema.enum) && schema.enum.length > 0;
  if (hasEnum && !schema.enum.some((e) => e === value)) {
    const normalized = normalizeEnum(value, schema.enum, isStringType);
    if (normalized !== NO_MATCH) {
      changed.value = true;
      return normalized;
    }
  }

  // 2) 递归对象：直接改字段（原值能被替换）
  if (!Array.isArray(value) && typeof value === 'object' && !hasEnum) {
    const props = schema.properties ?? {};
    // 2a) 删掉 schema 不允许的多余字段。
    // 实测这是导致任务失败的**头号原因**：模型总爱热心地多返回几个字段
    // （summary / notes / extra…），schema 判失败 → 重试 → 降级链耗尽。
    // 多出来的字段对我们是纯噪音，丢掉无损，判失败才是灾难。
    if (schema.additionalProperties === false && Object.keys(props).length) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) {
          delete value[key];
          changed.value = true;
        }
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (value[key] === undefined || value[key] === null) continue;
      const fixed = coerceInPlace(value[key], sub, changed);
      if (fixed !== NO_MATCH) value[key] = fixed;
    }
  }

  // 3) 递归数组
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i += 1) {
      // 3a) 形状对齐：schema 要字符串数组，模型给了对象数组
      //     （例如 findings: [{title, detail}] 而不是 ["...", "..."]）。
      //     这类"意思完全对、形状不对"的差异不该让任务失败 —— 取对象里最像正文的字段即可。
      const itemTypes =
        schema.items.type === undefined
          ? []
          : Array.isArray(schema.items.type)
            ? schema.items.type
            : [schema.items.type];
      if (itemTypes.includes('string') && value[i] !== null && typeof value[i] === 'object') {
        const collapsed = collapseToString(value[i]);
        if (collapsed !== null) {
          value[i] = collapsed;
          changed.value = true;
          continue;
        }
      }
      const fixed = coerceInPlace(value[i], schema.items, changed);
      if (fixed !== NO_MATCH) value[i] = fixed;
    }
  }

  return NO_MATCH;
}

/** 把对象压成一句人话字符串：优先取像"正文"的字段 */
function collapseToString(obj) {
  if (Array.isArray(obj)) {
    const parts = obj.map((x) => (typeof x === 'string' ? x : null)).filter(Boolean);
    return parts.length ? parts.join('；') : null;
  }
  const KEYS = [
    'content', 'text', 'detail', 'details', 'description', 'value', 'finding',
    'title', 'name', 'summary', 'item', 'point', 'problem', 'note', 'reason',
    'source', 'caution', 'risk', 'issue', 'advice', 'conclusion',
  ];
  const parts = [];
  const used = new Set();
  for (const k of KEYS) {
    if (typeof obj[k] === 'string' && obj[k].trim()) {
      parts.push(obj[k].trim());
      used.add(k);
    }
  }
  if (!parts.length) {
    // 兜底：只对**小对象**做拼接。
    // 大对象很可能是真的嵌套结构（例如 plan 里的 deliverable），
    // 硬压成字符串会丢信息 —— 那种情况应该让校验失败，由上层重试。
    const values = Object.values(obj);
    if (values.length > 6) return null;
    for (const v of values) {
      if (typeof v === 'string' && v.trim()) parts.push(v.trim());
    }
  }
  if (!parts.length) return null;
  return parts.join('：').replace(/：+/g, '：').slice(0, 600);
}

/** 便捷包装：只想知道「有没有改过」 */
export function coerce(value, schema) {
  const changed = { value: false };
  const replacement = coerceInPlace(value, schema, changed);
  return {
    value: replacement === NO_MATCH ? value : replacement,
    changed: changed.value || replacement !== NO_MATCH,
  };
}


/** 把一个不合规的值映射到 enum 里最接近的合法值 */
function normalizeEnum(value, enumValues, isStringType) {
  // ⚠️ 只处理标量。对象/数组绝不能被"收敛"成某个枚举值 ——
  // 这正是之前把 artifacts 数组变成 true 的路径之一。
  if (value !== null && typeof value === 'object') return NO_MATCH;

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
 * 把 schema 里的**全部**硬性约束渲染成一句句人话，附在提示词后面。
 *
 * 实测：模型对「请严格遵守 JSON Schema」这种抽象要求几乎无感，
 * 但对**具体取值列表、具体字段名、具体长度范围**非常敏感。
 * 所以这里不是"提醒一下格式"，而是把它必须满足的每一条都摊开写给它看。
 *
 * 这是本产品「任务不会莫名失败」的关键一环，改动前请先跑一次真实干跑。
 */
export function describeEnumConstraints(schema, path = '', out = []) {
  return describeConstraints(schema, path, out);
}

export function describeConstraints(schema, path = '', out = []) {
  if (!schema || typeof schema !== 'object') return out;
  const label = path || '根对象';

  if (Array.isArray(schema.enum)) {
    out.push(`${label} 只能取：${schema.enum.map((e) => JSON.stringify(e)).join(' | ')}`);
  }
  if (schema.const !== undefined) {
    out.push(`${label} 必须是 ${JSON.stringify(schema.const)}`);
  }
  if (typeof schema.minLength === 'number') {
    out.push(`${label} 至少 ${schema.minLength} 个字`);
  }
  if (typeof schema.maxLength === 'number') {
    out.push(`${label} 最多 ${schema.maxLength} 个字`);
  }
  if (typeof schema.minItems === 'number') {
    out.push(`${label} 至少 ${schema.minItems} 项`);
  }
  if (typeof schema.maxItems === 'number') {
    out.push(`${label} 最多 ${schema.maxItems} 项`);
  }
  if (typeof schema.minimum === 'number' || typeof schema.maximum === 'number') {
    out.push(
      `${label} 取值在 ${schema.minimum ?? '-∞'} 到 ${schema.maximum ?? '+∞'} 之间`,
    );
  }

  // 对象：把必填字段和「不许有额外字段」明说
  const props = schema.properties ?? {};
  const names = Object.keys(props);
  if (names.length) {
    out.push(`${label} 只能有这些字段：${names.map((n) => `"${n}"`).join('、')}`);
    if (Array.isArray(schema.required) && schema.required.length) {
      out.push(`${label} 的必填字段：${schema.required.map((n) => `"${n}"`).join('、')}`);
    }
    // additionalProperties:false 是最容易被模型违反的一条，必须显式警告
    if (schema.additionalProperties === false) {
      out.push(`⚠️ ${label} **绝对不要**增加上面没列出的任何字段`);
    }
  }

  for (const [key, sub] of Object.entries(props)) {
    describeConstraints(sub, path ? `${path}.${key}` : key, out);
  }
  if (schema.items) describeConstraints(schema.items, `${path}[]`, out);
  return out;
}


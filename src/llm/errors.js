/**
 * 统一错误码。
 *
 * 铁律：任何错误的 message 里都不允许出现 API Key。
 * 所有对外错误都经过 toPublicError() 洗一遍。
 */

export const ERR = {
  BAD_REQUEST: 'BAD_REQUEST',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  // LLM 相关
  LLM_TIMEOUT: 'LLM_TIMEOUT',
  LLM_HTTP_ERROR: 'LLM_HTTP_ERROR',
  LLM_JSON_INVALID: 'LLM_JSON_INVALID',
  LLM_SCHEMA_INVALID: 'LLM_SCHEMA_INVALID',
  LLM_NO_PROVIDER: 'LLM_NO_PROVIDER',
  LLM_ABORTED: 'LLM_ABORTED',
  LLM_EMPTY_RESPONSE: 'LLM_EMPTY_RESPONSE',
  // 流水线相关
  PIPELINE_STAGE_FAILED: 'PIPELINE_STAGE_FAILED',
  PIPELINE_CANCELLED: 'PIPELINE_CANCELLED',
  // 安全相关
  SECURITY_BLOCKED: 'SECURITY_BLOCKED',
};

export class AppError extends Error {
  constructor(code, message, { status = 500, cause, details } = {}) {
    super(message, { cause });
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

/** 供 HTTP 层使用：任何异常 → { status, body }，且保证不泄漏内部细节 */
export function toPublicError(err) {
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: { error: { code: err.code, message: err.message } },
    };
  }
  // 未知异常：对外只说「我们这边出问题了」，细节留给服务端日志
  return {
    status: 500,
    body: {
      error: {
        code: 'INTERNAL_ERROR',
        message: '服务内部出了点问题，我们已经记下来了。可以重试一次。',
      },
    },
  };
}

/**
 * 从任意字符串里抹掉密钥形态的内容。
 * 用在所有落盘日志、错误信息、对外响应上。宁可多抹一点。
 */
const SECRET_PATTERNS = [
  /QC-[A-Za-z0-9-]{16,}/g,
  /sk-[A-Za-z0-9_-]{12,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

export function redactSecrets(input) {
  if (input === null || input === undefined) return input;
  let s = typeof input === 'string' ? input : String(input);
  for (const re of SECRET_PATTERNS) s = s.replace(re, '[已隐去密钥]');
  return s;
}

/** 判断一段文本里是否疑似含有密钥（用于输出审计，不再改写内容时用） */
export function looksLikeSecret(text) {
  if (typeof text !== 'string') return false;
  return SECRET_PATTERNS.some((re) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}

export { SECRET_PATTERNS };

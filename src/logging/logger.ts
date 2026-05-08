export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export type LogSink = {
  write(message: string): unknown;
};

export type Logger = {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
};

export type LogFields = Record<string, unknown>;

const weights: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100
};

export function normalizeLogLevel(value: string | undefined): LogLevel {
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error' || value === 'silent') {
    return value;
  }

  return 'info';
}

export function createLogger(options: { name: string; level?: LogLevel; sink?: LogSink }): Logger {
  const level = options.level ?? 'info';
  const sink = options.sink ?? process.stderr;

  function write(entryLevel: Exclude<LogLevel, 'silent'>, message: string, fields: LogFields = {}): void {
    if (weights[entryLevel] < weights[level]) {
      return;
    }

    sink.write(`${JSON.stringify({
      time: new Date().toISOString(),
      level: entryLevel,
      name: options.name,
      message,
      ...fields
    })}\n`);
  }

  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields)
  };
}

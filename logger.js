/**
 * @fileoverview Система логирования для Chrome Extension
 * Поддерживает разные уровни логирования и сохранение в storage
 */

export class Logger {
  /**
   * @param {string} context - контекст логгера (например, 'background', 'content')
   */
  constructor(context = 'app') {
    this.context = context;
    this.enabled = true;
    this.logLevel = this.getLogLevel();
    this.maxStoredLogs = 1000; // Максимальное количество сохраняемых логов
  }

  /**
   * Уровни логирования
   */
  static LEVELS = {
    DEBUG: 0,
    LOG: 1,
    INFO: 2,
    WARN: 3,
    ERROR: 4
  };

  /**
   * Получение уровня логирования из storage
   * @returns {number}
   */
  getLogLevel() {
    // По умолчанию INFO
    return Logger.LEVELS.INFO;
  }

  /**
   * Форматирование сообщения
   * @param {string} level - уровень
   * @param {any[]} args - аргументы
   * @returns {Object}
   */
  formatMessage(level, args) {
    return {
      timestamp: new Date().toISOString(),
      context: this.context,
      level,
      message: args.map(arg => 
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
      ).join(' '),
      args: args
    };
  }

  /**
   * Отправка лога в консоль
   * @param {string} level - уровень
   * @param {any[]} args - аргументы
   */
  logToConsole(level, args) {
    const prefix = `[${this.context}]`;
    const consoleMethod = level.toLowerCase();
    
    if (console[consoleMethod]) {
      console[consoleMethod](prefix, ...args);
    } else {
      console.log(prefix, ...args);
    }
  }

  /**
   * Сохранение лога в storage
   * @param {Object} logEntry - запись лога
   */
  async saveToStorage(logEntry) {
    try {
      const storage = await chrome.storage.local.get(['logs']);
      const logs = storage.logs || [];
      
      logs.push(logEntry);
      
      // Ограничиваем размер лога
      if (logs.length > this.maxStoredLogs) {
        logs.shift();
      }
      
      await chrome.storage.local.set({ logs });
    } catch (error) {
      // Тихо игнорируем ошибки логирования
      console.error('[Logger] Ошибка сохранения лога:', error);
    }
  }

  /**
   * Основная функция логирования
   * @param {string} level - уровень
   * @param {any[]} args - аргументы
   */
  async logMessage(level, ...args) {
    if (!this.enabled) {
      return;
    }

    const levelNum = Logger.LEVELS[level];
    if (levelNum < this.logLevel) {
      return;
    }

    const logEntry = this.formatMessage(level, args);
    
    // Вывод в консоль
    this.logToConsole(level, args);
    
    // Сохранение в storage (асинхронно, без ожидания)
    this.saveToStorage(logEntry);
  }

  /**
   * Логирование DEBUG уровня
   * @param  {...any} args
   */
  debug(...args) {
    this.logMessage('DEBUG', ...args);
  }

  /**
   * Логирование LOG уровня
   * @param  {...any} args
   */
  log(...args) {
    this.logMessage('LOG', ...args);
  }

  /**
   * Логирование INFO уровня
   * @param  {...any} args
   */
  info(...args) {
    this.logMessage('INFO', ...args);
  }

  /**
   * Логирование WARN уровня
   * @param  {...any} args
   */
  warn(...args) {
    this.logMessage('WARN', ...args);
  }

  /**
   * Логирование ERROR уровня
   * @param  {...any} args
   */
  error(...args) {
    this.logMessage('ERROR', ...args);
  }

  /**
   * Получение сохранённых логов
   * @returns {Promise<Object[]>}
   */
  async getLogs() {
    const storage = await chrome.storage.local.get(['logs']);
    return storage.logs || [];
  }

  /**
   * Очистка логов
   */
  async clearLogs() {
    await chrome.storage.local.set({ logs: [] });
    this.info('Логи очищены');
  }

  /**
   * Экспорт логов в JSON
   * @returns {Promise<string>}
   */
  async exportLogs() {
    const logs = await this.getLogs();
    return JSON.stringify(logs, null, 2);
  }

  /**
   * Включение/выключение логирования
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    this.enabled = enabled;
  }

  /**
   * Установка уровня логирования
   * @param {string} level
   */
  setLogLevel(level) {
    if (Logger.LEVELS[level] !== undefined) {
      this.logLevel = Logger.LEVELS[level];
      this.info(`Уровень логирования установлен: ${level}`);
    }
  }
}

/**
 * Глобальный экземпляр логгера
 */
export const logger = new Logger('global');

/**
 * Перехват глобальных ошибок
 */
export function setupGlobalErrorHandling() {
  const globalLogger = new Logger('errors');

  // Перехват неза пойманных ошибок
  self.addEventListener('error', (event) => {
    globalLogger.error('Глобальная ошибка:', {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      stack: event.error?.stack
    });
  });

  // Перехват неза пойманных Promise ошибок
  self.addEventListener('unhandledrejection', (event) => {
    globalLogger.error('Необработанное Promise отклонение:', {
      reason: event.reason
    });
  });
}

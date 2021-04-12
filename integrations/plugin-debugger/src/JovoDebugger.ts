import {
  App,
  DeepPartial,
  Extensible,
  HandleRequest,
  Headers,
  InvalidParentError,
  Jovo,
  Platform,
  Plugin,
  PluginConfig,
  QueryParams,
  Server,
  SessionData,
} from '@jovotech/core';
import { NlpjsNlu, NlpjsNluInitConfig } from '@jovotech/nlu-nlpjs';
import { CorePlatform, CorePlatformConfig } from '@jovotech/platform-core';
import { LangEn } from '@nlpjs/lang-en';
import { promises } from 'fs';
import { join } from 'path';
import { connect, Socket } from 'socket.io-client';
import { Writable } from 'stream';
import { MockServer } from './MockServer';

export enum JovoDebuggerEvent {
  DebuggingAvailable = 'debugging.available',
  DebuggingUnavailable = 'debugging.unavailable',

  DebuggerRequest = 'debugger.request',
  DebuggerLanguageModelRequest = 'debugger.language-model-request',

  AppLanguageModelResponse = 'app.language-model-response',
  AppDebuggerConfigResponse = 'app.debugger-config-response',
  AppConsoleLog = 'app.console-log',
  AppRequest = 'app.request',
  AppResponse = 'app.response',

  AppJovoUpdate = 'app.jovo-update',
}

// TODO: check if type can be improved, same for Response
// problem with that is,that older versions still have this format
// to tackle that the data can be transformed in the frontend/backend
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface JovoDebuggerRequest {
  requestId: number;
  json: any;
  platformType: string;
  requestSessionAttributes: SessionData;
  userId: string;
  route?: any;
  inputs?: any;
  rawText?: string;
  database?: any;
  error?: any;
}

export interface JovoDebuggerResponse {
  requestId: number;
  json: any;
  database?: any;
  speech?: string;
  platformType: string;
  userId: string;
  route: any;
  sessionEnded: boolean;
  inputs: any;
  requestSessionAttributes: any;
  responseSessionAttributes: any;
  audioplayer?: any;
}

/* eslint-enable @typescript-eslint/no-explicit-any */

const WEBHOOK_ARGUMENT_OPTIONS = ['--intent', '--launch', '--file', '--template'];

// TODO: implement config
export interface JovoDebuggerConfig extends PluginConfig {
  corePlatform: DeepPartial<CorePlatformConfig>;
  nlpjsNlu: NlpjsNluInitConfig;
  webhookUrl: string;
  languageModelEnabled: boolean;
  languageModelPath: string;
  debuggerJsonPath: string;
}

export type JovoDebuggerInitConfig = DeepPartial<JovoDebuggerConfig> &
  Partial<Pick<JovoDebuggerConfig, 'nlpjsNlu'>>;

export class JovoDebugger extends Plugin<JovoDebuggerConfig> {
  socket?: typeof Socket;

  hasOverriddenWrite = false;

  // TODO determine whether number is sufficient
  requestIdCounter = 0;

  constructor(config?: JovoDebuggerInitConfig) {
    super(config);

    const jovoWebhookEnabled =
      process.argv.includes('--jovo-webhook') && !process.argv.includes('--disable-jovo-debugger');
    const webhookEnabled =
      process.argv.includes('--webhook') &&
      WEBHOOK_ARGUMENT_OPTIONS.some((argOption) => process.argv.includes(argOption));
    if (webhookEnabled || jovoWebhookEnabled) {
      this.config.enabled = true;
    }
  }

  // TODO check default config
  getDefaultConfig(): JovoDebuggerConfig {
    return {
      corePlatform: {},
      nlpjsNlu: {
        languageMap: {
          en: LangEn,
        },
      },
      webhookUrl: 'https://webhook.jovo.cloud',
      enabled: false,
      languageModelEnabled: true,
      languageModelPath: './models',
      debuggerJsonPath: './debugger.json',
    };
  }

  install(parent: Extensible) {
    if (!(parent instanceof App)) {
      // TODO: implement error
      throw new InvalidParentError();
    }

    // TODO: determine handling of edge-cases
    this.installDebuggerPlatform(parent);
  }

  private installDebuggerPlatform(app: App) {
    const JovoDebuggerPlatform = CorePlatform.create('JovoDebuggerPlatform', 'jovo-debugger');
    app.use(
      new JovoDebuggerPlatform({
        ...this.config.corePlatform,
        plugins: [new NlpjsNlu(this.config.nlpjsNlu)],
      }),
    );
  }

  async initialize(app: App): Promise<void> {
    // TODO make request if launch options passed
    if (this.config.enabled === false) return;

    await this.connectToWebhook();
    if (!this.socket) {
      // TODO: implement error
      throw new Error();
    }

    this.socket.on(JovoDebuggerEvent.DebuggingAvailable, this.onDebuggingAvailable);
    this.socket.on(
      JovoDebuggerEvent.DebuggerLanguageModelRequest,
      this.onDebuggerLanguageModelRequest,
    );
    this.socket.on(JovoDebuggerEvent.DebuggerRequest, this.onDebuggerRequest.bind(this, app));

    // TODO determine whether it should be called here
    app.middlewareCollection.use('before.request', this.onRequest);
    app.middlewareCollection.use('after.response', this.onResponse);

    this.patchHandleRequestToIncludeUniqueId();
    this.patchPlatformsToCreateJovoAsProxy(app.platforms);
  }

  // TODO: maybe find a better solution although this might work well because it is independent of the RIDR-pipeline
  // -> future changes are less likely to cause breaking changes here
  private patchHandleRequestToIncludeUniqueId() {
    const getRequestId = () => this.requestIdCounter++;
    const mount = HandleRequest.prototype.mount;
    HandleRequest.prototype.mount = function () {
      this.debuggerRequestId = getRequestId();
      return mount.call(this);
    };
  }

  private patchPlatformsToCreateJovoAsProxy(platforms: ReadonlyArray<Platform>) {
    platforms.forEach((platform) => {
      const createJovoFn = platform.createJovoInstance;
      platform.createJovoInstance = (app, handleRequest) => {
        const jovo = createJovoFn.call(platform, app, handleRequest);
        // propagate initial values, might not be required, TBD
        for (const key in jovo) {
          const isEmptyObject =
            typeof jovo[key as keyof Jovo] === 'object' &&
            !Array.isArray(jovo[key as keyof Jovo]) &&
            !Object.keys(jovo[key as keyof Jovo]).length;
          const isEmptyArray =
            Array.isArray(jovo[key as keyof Jovo]) && !jovo[key as keyof Jovo].length;
          if (
            !jovo.hasOwnProperty(key) ||
            ['$app', '$handleRequest', '$platform'].includes(key) ||
            !jovo[key as keyof Jovo] ||
            isEmptyObject ||
            isEmptyArray
          ) {
            continue;
          }
          this.socket?.emit(JovoDebuggerEvent.AppJovoUpdate, {
            requestId: handleRequest.debuggerRequestId,
            key,
            value: jovo[key as keyof Jovo],
            path: key,
          });
        }
        return new Proxy(jovo, this.getProxyHandler(handleRequest));
      };
    });
  }

  private getProxyHandler<T extends Record<string, any>>(
    handleRequest: HandleRequest,
    path = '',
  ): ProxyHandler<T> {
    return {
      get: (target, key: string) => {
        if (typeof target[key] === 'object' && target[key] !== null) {
          return new Proxy(
            target[key],
            this.getProxyHandler(handleRequest, path ? [path, key].join('.') : key),
          );
        } else {
          return target[key];
        }
      },
      set: (target, key: string, value: unknown): boolean => {
        // TODO determine whether empty values should be emitted, in the initial emit, they're omitted.
        (target as Record<string, unknown>)[key] = value;
        this.socket?.emit(JovoDebuggerEvent.AppJovoUpdate, {
          requestId: handleRequest.debuggerRequestId,
          key,
          value,
          path: path ? [path, key].join('.') : key,
        });
        return true;
      },
    };
  }

  private onDebuggingAvailable = () => {
    if (!this.socket) {
      // TODO: implement error
      throw new Error();
    }

    // TODO: check if there is a better way and this is desired
    function propagateStreamAsLog(stream: Writable, socket: typeof Socket) {
      const originalWriteFn = stream.write;
      stream.write = function (chunk: Buffer, ...args: any[]) {
        socket.emit(JovoDebuggerEvent.AppConsoleLog, chunk.toString(), new Error().stack);
        return originalWriteFn.call(this, chunk, ...args);
      };
    }

    if (!this.hasOverriddenWrite) {
      propagateStreamAsLog(process.stdout, this.socket);
      propagateStreamAsLog(process.stderr, this.socket);
      this.hasOverriddenWrite = true;
    }
  };

  private onDebuggerLanguageModelRequest = async () => {
    if (!this.config.languageModelEnabled) return;
    if (!this.config.languageModelPath || !this.config.debuggerJsonPath) {
      // TODO: implement error
      throw new Error();
    }
    if (!this.socket) {
      // TODO: implement error
      throw new Error();
    }
    // look for language-models
    // TODO: implement building language-model-obj
    const languageModel: any = {};

    this.socket.emit(JovoDebuggerEvent.AppLanguageModelResponse);

    // TODO implement sending debuggerConfig
  };

  private onDebuggerRequest = async (app: App, request: any) => {
    const userId: string = request.userId || 'jovo-debugger-user';
    await app.handle(new MockServer(request));
  };

  private onRequest = (handleRequest: HandleRequest, jovo: Jovo) => {
    if (!this.socket) {
      // TODO: implement error
      throw new Error();
    }
    // TODO: complete filling request from data in jovo and check platformType
    const request: JovoDebuggerRequest = {
      requestId: handleRequest.debuggerRequestId,
      inputs: jovo.$entities,
      json: jovo.$request,
      platformType: jovo.constructor.name,
      requestSessionAttributes: {},
      route: jovo.$route,
      userId: '',
    };

    this.socket.emit(JovoDebuggerEvent.AppRequest, request);
  };

  private onResponse = (handleRequest: HandleRequest, jovo: Jovo) => {
    if (!this.socket) {
      // TODO: implement error
      throw new Error();
    }
    // TODO: fill response from data in jovo and check platformType
    const response: JovoDebuggerResponse = {
      requestId: handleRequest.debuggerRequestId,
      inputs: jovo.$entities,
      json: jovo.$response,
      platformType: jovo.constructor.name,
      requestSessionAttributes: {},
      responseSessionAttributes: jovo.$session.$data,
      route: jovo.$route,
      sessionEnded: false,
      speech: '',
      userId: '',
    };

    this.socket.emit(JovoDebuggerEvent.AppResponse, response);
  };

  private async connectToWebhook() {
    // const webhookId = await this.retrieveLocalWebhookId();
    // this.socket = connect(this.config.webhookUrl, {
    //   query: {
    //     id: webhookId,
    //     type: 'app',
    //   },
    // });
    this.socket = connect('http://localhost:8443', {
      query: {
        id: 'test',
        type: 'app',
      },
    });
    this.socket.on('connect_error', (error: Error) => {
      // TODO: handle error
    });
  }

  private async retrieveLocalWebhookId(): Promise<string> {
    try {
      const homeConfigPath = join(this.getUserHomePath(), '.jovo/config');
      const homeConfigBuffer = await promises.readFile(homeConfigPath);
      const homeConfigData = JSON.parse(homeConfigBuffer.toString());
      if (homeConfigData?.webhook?.uuid) {
        return homeConfigData.webhook.uuid;
      }
      // TODO implement error
      throw new Error();
    } catch (e) {
      // TODO implement error
      throw new Error();
    }
  }

  private getUserHomePath(): string {
    const path = process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'];
    if (!path) {
      // TODO implement error
      throw new Error();
    }
    return path;
  }
}

/**
 * @typedef {Object} BrokerageApi
 * @property {(name: string) => any} getAdapter
 * @property {() => any} getExecutionConfig
 * @property {(name: string) => any} getProviderConfig
 * @property {(context: any) => { provider: string, source: string, matchedKey?: string }} resolveProvider
 * @property {(context: any) => { provider: string, adapter: any, source: string, matchedKey?: string }} resolveAdapter
 */

/**
 * @typedef {Object} InstrumentInfoApi
 * @property {(context:any,options?:any) => Promise<any|null>} get
 * @property {(context:any) => any|null} peek
 * @property {(context:any) => Promise<boolean>} forget
 * @property {(context:any,options?:any) => number} resolveTickSize
 * @property {(context:any,options?:any) => {tickSize:number,source:string}} getTickSizeResolution
 * @property {(context:any,deltaPrice:number,options?:any) => number|undefined} toPoints
 * @property {(name:string,callback:Function) => Function|null} registerMetadataPrewarmer
 * @property {(eventName:'updated',handler:Function) => Function} on
 */

/**
 * @typedef {Object} DealTrackersApi
 * @property {(info: any, opts?: any) => void} notifyPositionClosed
 * @property {(info: any, opts?: any) => boolean} shouldWritePositionClosed
 * @property {(data: any) => any} calcDealData
 */

/**
 * @typedef {Object} DealTrackersChartImagesApi
 * @property {(cfg?: any) => any} buildChartComposer
 * @property {any} [defaultComposer]
 * @property {(symbol: string) => string|undefined} compose1D
 * @property {(symbol: string) => string|undefined} compose5M
 */

/**
 * @typedef {Object} NgrokApi
 * @property {string} url
 * @property {() => Promise<void>} [stop]
 */

/**
 * @typedef {Object} McpApi
 * @property {string} url
 * @property {() => Promise<void>} [stop]
 */

/**
 * @typedef {import('electron-updater').AppUpdater} AutoUpdaterApi
 */

/**
 * @typedef {Object} ServicesApi
 * @property {BrokerageApi} [brokerage]
 * @property {InstrumentInfoApi} [instrumentInfo]
 * @property {DealTrackersApi} [dealTrackers]
 * @property {DealTrackersChartImagesApi} [dealTrackersChartImages]
 * @property {NgrokApi} [ngrok]
 * @property {McpApi} [mcp]
 * @property {AutoUpdaterApi} [autoUpdater]
 * @property {import('./tradeRules')} [tradeRules]
 * @property {{listConfigs:Function,readConfig:Function,writeConfig:Function,saveAndApplyConfig:Function,getRestartStatus:Function,onApply:Function}} [settings]
 */

module.exports = { commands: [] };

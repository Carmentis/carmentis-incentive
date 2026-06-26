export interface Config {
    nodeUrl: string,
    indexerUrl: string,
    privateKey: string,
    publicReference: string,
    startDate: string,
    periodInSeconds: number,
    dryRun: boolean,
    excludedNodes: string[],
}

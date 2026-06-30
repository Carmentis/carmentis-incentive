import { Config } from "./types";
import * as Logger from "./Logger";
import * as httpClient from "./indexer-sdk/http-client/http-client";
import * as indexer from "./indexer-sdk/indexer-api";
import {
    ProviderFactory,
    CryptoEncoderFactory,
    PrivateSignatureKey,
    PublicSignatureKey,
    SectionType,
    Provider,
    Hash,
    Utils,
    CMTSToken,
} from "@cmts-dev/carmentis-sdk-core";
import { ValidatorNodeDto } from "./indexer-sdk/model";

type ExtendedNode = {
    dto: ValidatorNodeDto;
    accountId: string;
    unpaidRewardInAtomics: number;
}
type Payer = {
    sk: PrivateSignatureKey,
    pk: PublicSignatureKey,
    accountHash: Hash,
    accountId: string,
}

export class RewardProcessor {
    private readonly config: Config;
    private readonly provider: Provider;
    private now = 0;
    private payer: Payer | undefined;

    constructor(config: Config) {
        Logger.info("initializing RewardProcessor with the following config:");
        const shownConfig = { ...config, privateKey: "**redacted**" };
        Logger.info(JSON.stringify(shownConfig, null, 2));
        this.config = config;
        this.provider = ProviderFactory.createInMemoryProviderWithExternalProvider(this.config.nodeUrl);
        httpClient.setApiBaseUrl(config.indexerUrl);
    }

    static roundTimestampToHour(ts: number) {
        const date = new Date(ts);
        return Date.UTC(
            date.getUTCFullYear(),
            date.getUTCMonth(),
            date.getUTCDate(),
            date.getUTCHours(),
        );
    }

    getPayerOrFail(): Payer {
        if (this.payer === undefined) {
            throw new Error("payer not initialized");
        }
        return this.payer;
    }

    async tick() {
        Logger.info("starting new round");
        this.now = Date.now();
        await this.payNextNode();
        Logger.info("end of round");
    }

    async payNextNode() {
        // get the current list of validator nodes
        const fullNodeList = await this.getNodeList();

        // remove exlcuded nodes
        const nodeList = fullNodeList.filter((node) =>
            !this.config.excludedNodes.includes(
                node.dto.virtualBlockchainId.toUpperCase()
            )
        );

        if (nodeList.length === 0) {
            Logger.error("empty list of validator nodes");
            return null;
        }

        // get the unpaid amount to date for each node
        const payerAccountId = this.getPayerOrFail().accountId;
        const startTs = new Date(this.config.startDate).getTime();

        for (const node of nodeList) {
            const nodeId = node.dto.virtualBlockchainId;
            const rewards = await indexer.appControllerGetNodeReward({
                node_id: nodeId,
                payer_account_id: payerAccountId,
                start_time: startTs,
                end_time: this.now,
            });
            node.unpaidRewardInAtomics = Math.floor(rewards.data.unpaidRewardInAtomics);
        }

        // sort this list by unpaid rewards, in descending order
        nodeList.sort((a, b) => b.unpaidRewardInAtomics - a.unpaidRewardInAtomics);
        Logger.info(`top 5 of unpaid rewards:`);
        for (let i = 0; i < Math.min(5, nodeList.length); i++) {
            Logger.info(`${nodeList[i].dto.virtualBlockchainId}: ${nodeList[i].unpaidRewardInAtomics} atomics`);
        }

        // the next node is the first entry
        const nextNode = nodeList[0];
        const nextNodeId = nextNode.dto.virtualBlockchainId;

        Logger.info(`next eligible node: ${nextNodeId}`);
        const amountInAtomics = nextNode.unpaidRewardInAtomics;
        if (amountInAtomics > 0) {
            await this.transferTokens(amountInAtomics, nextNode.accountId, nextNodeId);
            return;
        }

        Logger.error("no outstanding rewards to pay");
    }

    async getNodeList() {
        const nodeList = await indexer.appControllerGetValidatorNodes();
        const res: ExtendedNode[] = [];
        for (const node of nodeList.data.items) {
            const organizations = await indexer.appControllerGetOrganizations({
                vb_id: node.organizationId,
            });
            if (organizations.data.items.length === 1) {
                const extendedNode: ExtendedNode = {
                    dto: node,
                    accountId: organizations.data.items[0].accountId,
                    unpaidRewardInAtomics: 0,
                };
                res.push(extendedNode);
            }
        }
        return res;
    }

    async transferTokens(amountInAtomics: number, accountId: string, nodeId: string) {
        Logger.info(`sending ${amountInAtomics} atomics to account ${accountId}`);

        const payer = this.getPayerOrFail();
        const payerAccount = await this.provider.loadAccountVirtualBlockchain(payer.accountHash);
        const tokenTransferMb = await payerAccount.createMicroblock();
        const publicReference = this.config.publicReference.replace(/<NODE_ID>/, nodeId);

        tokenTransferMb.addSection({
            type: SectionType.ACCOUNT_TRANSFER,
            amount: amountInAtomics,
            publicReference,
            privateReference: '',
            account: Utils.binaryFromHexa(accountId)
        });

        tokenTransferMb.setGasPrice(CMTSToken.createMilliToken(1));
        await tokenTransferMb.setGasAndSeal(
            this.provider,
            payer.sk,
            {
                feesPayerAccount: payer.accountHash.toBytes()
            }
        );
        if (this.config.dryRun === true) {
            Logger.info(`aborting because of 'dry_run' flag`);
            Logger.info(`Built microblock: ${Utils.jsonPrettify(tokenTransferMb)}`);
        } else {
          await this.provider.publishMicroblock(tokenTransferMb);
        }
    }

    async loadPayer() {
        Logger.info("loading the payer account information");

        try {
            const encoder = CryptoEncoderFactory.defaultStringSignatureEncoder();
            const sk = await encoder.decodePrivateKey(this.config.privateKey);
            const pk = await sk.getPublicKey();
            const accountHash = Hash.from(
                await this.provider.getAccountIdByPublicKey(pk)
            );
            const accountId = Utils.binaryToHexa(accountHash.toBytes());
            Logger.info(`payer public key is ${Utils.binaryToHexa(await pk.getPublicKeyAsBytes())}`);
            Logger.info(`payer account is ${accountId}`);
            this.payer = {sk, pk, accountHash, accountId};
        }
        catch (error) {
            Logger.error("unable to load the payer account information - is 'private_key' valid?")
            throw error;
        }
    }
}

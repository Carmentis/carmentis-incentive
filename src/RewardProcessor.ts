import { Config } from "./types";
import * as Logger from "./Logger";
import * as httpClient from "./indexer-sdk/http-client/http-client";
import * as indexer from "./indexer-sdk/indexer-api";
import {
    BK_SENT_PAYMENT,
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
import { BlockDto, ValidatorNodeDto } from "./indexer-sdk/model";

const REWARD_RATE_PER_YEAR = 0.10;
const MS_IN_YEAR = 365 * 24 * 60 * 60 * 1000;
const REWARD_RATE_PER_MS = REWARD_RATE_PER_YEAR / MS_IN_YEAR;

type ExtendedNode = {
    dto: ValidatorNodeDto;
    accountId: string;
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
    private now: number;
    private payer: Payer;

    constructor(config: Config) {
        Logger.info("RewardProcessor initialized with the following config:");
        Logger.info(JSON.stringify(config, null, 2));
        this.config = config;
        this.provider = ProviderFactory.createInMemoryProviderWithExternalProvider(this.config.nodeUrl);
        httpClient.setApiBaseUrl(config.indexerUrl);
    }

    async tick() {
        if (this.payer === undefined) {
            throw new Error("payer not initialized");
        }
        Logger.info("starting new round");
        this.now = Date.now();
        await this.payNextNode();
        Logger.info("end of round");
    }

    async payNextNode() {
        // get the current list of validator nodes
        const nodeList = await this.getNodeList();
        if (nodeList.length === 0) {
            Logger.error("empty list of validator nodes");
            return null;
        }
        // normalize the list by sorting by VB ID
        nodeList.sort((a, b) => {
            return a.dto.virtualBlockchainId > b.dto.virtualBlockchainId ? 1 : -1;
        });

        // compute the starting point in the list
        // (next node after the last paid node, or 0 if not found)
        let nodeIndex: number;
        const lastPaidAccountId = await this.getLastPaidAccountId();

        if (lastPaidAccountId === null) {
            Logger.warn("no previous payment found");
            nodeIndex = 0;
        }
        else {
            const lastPaidNodeIndex = nodeList.findIndex((node) =>
                node.accountId === lastPaidAccountId
            );
            if (lastPaidNodeIndex === -1) {
                Logger.warn("last paid node not found in current list of validator nodes");
                nodeIndex = 0;
            }
            else {
                nodeIndex = (lastPaidNodeIndex + 1) % nodeList.length;
            }
        }

        // look for the first node from the starting point that has proposed
        // at least one block during the last hour and for which the amount
        // to be paid is greater than 0
        const blocksFromLastHour = await this.getBlocksFromLastHour();

        for (let n = 0; n < nodeList.length; n++) {
            const node = nodeList[nodeIndex]
            const eligible = blocksFromLastHour.some((block) =>
                block.proposerAddress === node.dto.address
            );
            if (eligible) {
                Logger.info(`next eligible node: ${node.dto.virtualBlockchainId}`);
                const amountInAtomics = await this.getAmountToPay(node);
                if (amountInAtomics > 0) {
                    await this.transferTokens(amountInAtomics, node.accountId);
                    return;
                }
            }
            nodeIndex = (nodeIndex + 1) % nodeList.length;
        }
        Logger.error("no node meets the reward conditions");
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
                    accountId: organizations.data.items[0].accountId
                };
                res.push(extendedNode);
            }
        }
        return res;
    }

    async getLastPaidAccountId() {
        const paymentList = await indexer.appControllerGetAccountHistory({
            account_id: this.payer.accountId,
            type: BK_SENT_PAYMENT,
            sort: "height",
            order: "DESC",
            limit: 1,
        });
        if (paymentList.data.items.length == 0) {
            return null;
        }
        return paymentList.data.items[0].linkedAccountId;
    }

    async getAmountToPay(node: ExtendedNode) {
        const dueAmountInAtomics = await this.getDueAmount(node);
        const paidAmountInAtomics = await this.getPaidAmount(node);
        const amountInAtomics = dueAmountInAtomics - paidAmountInAtomics;

        Logger.info(`due amount: ${dueAmountInAtomics} atomics`);
        Logger.info(`already paid amount: ${paidAmountInAtomics} atomics`);

        if (amountInAtomics < 0) {
            Logger.error("amount to be paid is negative");
            return 0;
        }
        if (amountInAtomics == 0) {
            Logger.warn("amount to be paid is zero");
        }
        return amountInAtomics;
    }

    async transferTokens(amountInAtomics: number, accountId: string) {
        Logger.info(`sending ${amountInAtomics} atomics to account ${accountId}`);

        const payerAccount = await this.provider.loadAccountVirtualBlockchain(this.payer.accountHash);
        const tokenTransferMb = await payerAccount.createMicroblock();
        tokenTransferMb.addSection({
            type: SectionType.ACCOUNT_TRANSFER,
            amount: amountInAtomics,
            publicReference: this.config.publicReference,
            privateReference: '',
            account: Utils.binaryFromHexa(accountId)
        });

        tokenTransferMb.setGasPrice(CMTSToken.createMilliToken(1));
        await tokenTransferMb.setGasAndSeal(
            this.provider,
            this.payer.sk,
            {
                feesPayerAccount: this.payer.accountHash.toBytes()
            }
        );
        await this.provider.publishMicroblock(tokenTransferMb);
    }

    async getDueAmount(node: ExtendedNode) {
        const response = await indexer.appControllerGetVotingPowers({
            node_id: node.dto.virtualBlockchainId,
            sort: "height",
            order: "ASC",
        });
        const votingPowers = response.data.items;
        let lastTs = new Date(this.config.startDate).getTime();
        if(isNaN(lastTs)) {
            throw new Error("invalid start date");
        }
        let votingPower = 0;
        let dueInAtomics = 0;

        // compute due amount updates at each voting power update
        for (const vp of votingPowers) {
            dueInAtomics += this.getDueAmountForPeriod(lastTs, vp.timestamp, votingPower);
            lastTs = vp.timestamp;
            votingPower = vp.votingPower;
        }
        // add due amount from the last voting power update to now
        dueInAtomics += this.getDueAmountForPeriod(lastTs, this.now, votingPower);

        return Math.round(dueInAtomics);
    }

    getDueAmountForPeriod(from: number, to: number, votingPower: number) {
        const fromAsStr = new Date(from).toISOString();
        const toAsStr = new Date(to).toISOString();
        const delta = to - from;
        if (delta < 0) {
            Logger.warn(`inconsistent period from ${fromAsStr} to ${toAsStr}: due amount is 0`);
            return 0;
        }
        const amount = delta * REWARD_RATE_PER_MS * votingPower;
        Logger.info(`due amount from ${fromAsStr} to ${toAsStr}: ${amount} atomics`);
        return amount;
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

    async getPaidAmount(node: ExtendedNode) {
        let minHeight = 0;
        let hasMore = true;
        let paidInAtomics = 0;

        while (hasMore) {
            const response = await indexer.appControllerGetAccountHistory({
                account_id: this.payer.accountId,
                linked_account_id: node.accountId,
                type: BK_SENT_PAYMENT,
                height_gte: minHeight,
                sort: "height",
                order: "ASC",
            });
            const items = response.data.items;
            for (const item of items) {
                paidInAtomics += item.amount;
            }
            if (items.length > 0) {
                minHeight = items[items.length - 1].height + 1;
            }
            hasMore = response.data.hasMore;
        }
        return paidInAtomics;
    }

    async getBlocksFromLastHour() {
        const oneHourAgo = this.now - 3600000;
        const blockList: BlockDto[] = [];
        let minHeight = 0;
        let hasMore = true;

        while (hasMore) {
            const response = await indexer.appControllerGetBlocks({
                height_gte: minHeight,
                timestamp_gte: oneHourAgo,
                timestamp_lte: this.now,
                sort: "height",
                order: "ASC",
            });
            const items = response.data.items;
            blockList.push(...items);
            if (items.length > 0) {
                minHeight = items[items.length - 1].height + 1;
            }
            hasMore = response.data.hasMore;
        }
        return blockList;
    }
}

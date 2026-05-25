import { Config } from "./types";
import {
    Indexer,
    SortOrder,
    AccountHistorySort,
    BlockSort,
    VotingPowerSort,
    Block,
    ValidatorNode,
} from "@cmts-dev/carmentis-indexer-sdk";
import * as Logger from "./Logger";
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

const REWARD_RATE_PER_YEAR = 0.10;
const MS_IN_YEAR = 365 * 24 * 60 * 60 * 1000;
const REWARD_RATE_PER_MS = REWARD_RATE_PER_YEAR / MS_IN_YEAR;

type ExtendedNode = {
    dto: ValidatorNode;
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
    private readonly indexer: Indexer;
    private readonly provider: Provider;
    private now: number;
    private payer: Payer;

    constructor(config: Config) {
        this.config = config;
        this.indexer = new Indexer(config.indexerUrl);
        this.provider = ProviderFactory.createInMemoryProviderWithExternalProvider(this.config.nodeUrl);
    }

    async tick() {
        if (this.payer === undefined) {
            throw new Error("payer not initialized");
        }
        this.now = Date.now();
        const node = await this.getNextNode();
        if (node === null) {
            Logger.error("no eligible node");
        } else {
            Logger.info("selected node: " + node.dto.virtualBlockchainId);
            await this.payNode(node);
            Logger.info("process completed");
        }
    }

    async getNextNode() {
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
        // at least one block during the last hour
        const blocksFromLastHour = await this.getBlocksFromLastHour();

        for (let n = 0; n < nodeList.length; n++) {
            const node = nodeList[nodeIndex]
            if (blocksFromLastHour.some((block) => block.proposerAddress === node.dto.address)) {
                return node;
            }
            nodeIndex = (nodeIndex + 1) % nodeList.length;
        }
        return null;
    }

    async getNodeList() {
        const nodeList = await this.indexer.getValidatorNodes();
        const res: ExtendedNode[] = [];
        for (const node of nodeList.items) {
            const organization = await this.indexer.getOrganizations({
                vb_id: node.organizationId,
            });
            if (organization.items.length === 1) {
                const extendedNode: ExtendedNode = {
                    dto: node,
                    accountId: organization.items[0].accountId
                };
                res.push(extendedNode);
            }
        }
        return res;
    }

    async getLastPaidAccountId() {
        const paymentList = await this.indexer.getAccountHistory({
            account_id: this.payer.accountId,
            type: BK_SENT_PAYMENT,
            sort: AccountHistorySort.HEIGHT,
            order: SortOrder.DESC,
            limit: 1,
        });
        if (paymentList.items.length == 0) {
            return null;
        }
        return paymentList.items[0].linkedAccountId;
    }

    async payNode(node: ExtendedNode) {
        const dueAmountInAtomics = await this.getDueAmount(node);
        const paidAmountInAtomics = await this.getPaidAmount(node);
        const amountInAtomics = dueAmountInAtomics - paidAmountInAtomics;

        Logger.info(`due amount: ${dueAmountInAtomics} atomics`);
        Logger.info(`already paid amount: ${paidAmountInAtomics} atomics`);

        if (amountInAtomics < 0) {
            Logger.error("amount to be paid is negative");
            return;
        }
        if (amountInAtomics == 0) {
            Logger.warn("amount to be paid is zero");
            return;
        }

        await this.transferTokens(amountInAtomics, node.accountId);
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
        const response = await this.indexer.getVotingPower({
            node_id: node.dto.virtualBlockchainId,
            sort: VotingPowerSort.HEIGHT,
            order: SortOrder.ASC,
        });
        const votingPowers = response.items;
        let lastTs = 0;
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
        const amount = (to - from) * REWARD_RATE_PER_MS * votingPower;
        const fromAsStr = new Date(from).toISOString();
        const toAsStr = new Date(to).toISOString();
        Logger.info(`due from ${fromAsStr} to ${toAsStr}: ${amount} atomics`);
        return amount;
    }

    async loadPayer() {
        const encoder = CryptoEncoderFactory.defaultStringSignatureEncoder();
        const sk = await encoder.decodePrivateKey(this.config.privateKey);
        const pk = await sk.getPublicKey();
        const accountHash = Hash.from(
            await this.provider.getAccountIdByPublicKey(pk)
        );
        const accountId = Utils.binaryToHexa(accountHash.toBytes());
        Logger.info(`payer public key is ${Utils.binaryToHexa(await pk.getPublicKeyAsBytes())}`);
        Logger.info(`payer account is ${accountId}`);
        this.payer = { sk, pk, accountHash, accountId };
    }

    async getPaidAmount(node: ExtendedNode) {
        let minHeight = 0;
        let hasMore = true;
        let paidInAtomics = 0;

        while (hasMore) {
            const response = await this.indexer.getAccountHistory({
                account_id: this.payer.accountId,
                linked_account_id: node.accountId,
                type: BK_SENT_PAYMENT,
                height_gte: minHeight,
                sort: AccountHistorySort.HEIGHT,
                order: SortOrder.ASC,
            });
            for (const item of response.items) {
                paidInAtomics += item.amount;
            }
            if (response.items.length > 0) {
                minHeight = response.items[response.items.length - 1].height + 1;
            }
            hasMore = response.hasMore;
        }
        return paidInAtomics;
    }

    async getBlocksFromLastHour() {
        const oneHourAgo = this.now - 3600000;
        const blockList: Block[] = [];
        let minHeight = 0;
        let hasMore = true;

        while (hasMore) {
            const response = await this.indexer.getBlocks({
                height_gte: minHeight,
                timestamp_gte: oneHourAgo,
                timestamp_lte: this.now,
                sort: BlockSort.HEIGHT,
                order: SortOrder.ASC,
            });
            blockList.push(...response.items);
            if (response.items.length > 0) {
                minHeight = response.items[response.items.length - 1].height + 1;
            }
            hasMore = response.hasMore;
        }
        return blockList;
    }
}

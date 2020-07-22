export class DeleteItem {
    /**
     * @param {number} clock
     * @param {number} len
     */
    constructor(clock: number, len: number);
    /**
     * @type {number}
     */
    clock: number;
    /**
     * @type {number}
     */
    len: number;
}
/**
 * We no longer maintain a DeleteStore. DeleteSet is a temporary object that is created when needed.
 * - When created in a transaction, it must only be accessed after sorting, and merging
 *   - This DeleteSet is send to other clients
 * - We do not create a DeleteSet when we send a sync message. The DeleteSet message is created directly from StructStore
 * - We read a DeleteSet as part of a sync/update message. In this case the DeleteSet is already sorted and merged.
 */
export class DeleteSet {
    /**
     * @type {Map<number,Array<DeleteItem>>}
     */
    clients: Map<number, Array<DeleteItem>>;
}
export function iterateDeletedStructs(transaction: Transaction, ds: DeleteSet, f: (arg0: GC | Item) => void): void;
export function findIndexDS(dis: Array<DeleteItem>, clock: number): number | null;
export function isDeleted(ds: DeleteSet, id: ID): boolean;
export function sortAndMergeDeleteSet(ds: DeleteSet): void;
export function mergeDeleteSets(dss: Array<DeleteSet>): DeleteSet;
export function addToDeleteSet(ds: DeleteSet, client: number, clock: number, length: number): void;
export function createDeleteSet(): DeleteSet;
export function createDeleteSetFromStructStore(ss: StructStore): DeleteSet;
export function writeDeleteSet(encoder: AbstractDSEncoder, ds: DeleteSet): void;
export function readDeleteSet(decoder: AbstractDSDecoder): DeleteSet;
export function readAndApplyDeleteSet(decoder: AbstractDSDecoder, transaction: Transaction, store: StructStore): void;
export function applyDeleteItem(transaction: Transaction, structs: Array<GC | Item>, { clock, len }: DeleteItem): void;
import { Transaction } from "./Transaction.js";
import { GC } from "../structs/GC.js";
import { Item } from "../structs/Item.js";
import { ID } from "./ID.js";
import { StructStore } from "./StructStore.js";
import { AbstractDSEncoder } from "./UpdateEncoder.js";
import { AbstractDSDecoder } from "./UpdateDecoder.js";

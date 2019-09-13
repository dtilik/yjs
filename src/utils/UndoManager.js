import {
  mergeDeleteSets,
  iterateDeletedStructs,
  keepItem,
  transact,
  redoItem,
  iterateStructs,
  isParentOf,
  createID,
  followRedone,
  getItemCleanStart,
  Transaction, Doc, Item, GC, DeleteSet, AbstractType // eslint-disable-line
} from '../internals.js'

import * as time from 'lib0/time.js'
import { Observable } from 'lib0/observable.js'

class StackItem {
  /**
   * @param {DeleteSet} ds
   * @param {number} start clock start of the local client
   * @param {number} len
   */
  constructor (ds, start, len) {
    this.ds = ds
    this.start = start
    this.len = len
    /**
     * Use this to save and restore metadata like selection range
     */
    this.meta = new Map()
  }
}

/**
 * @param {UndoManager} undoManager
 * @param {Array<StackItem>} stack
 * @param {string} eventType
 * @return {StackItem?}
 */
const popStackItem = (undoManager, stack, eventType) => {
  /**
   * Whether a change happened
   * @type {StackItem?}
   */
  let result = null
  const doc = undoManager.doc
  const scope = undoManager.scope
  transact(doc, transaction => {
    while (stack.length > 0 && result === null) {
      const store = doc.store
      const stackItem = /** @type {StackItem} */ (stack.pop())
      const itemsToRedo = new Set()
      let performedChange = false

      const structs = /** @type {Array<GC|Item>} */ (store.clients.get(doc.clientID))
      const startClock = stackItem.start
      const endClock = stackItem.start + stackItem.len - 1
      const endStructsClock = structs[structs.length - 1].id.clock + structs[structs.length - 1].length - 1

      // make sure structs don't overlap with the range of created operations [stackItem.start, stackItem.start + stackItem.end)
      if (endStructsClock >= startClock) {
        getItemCleanStart(transaction, store, createID(doc.clientID, stackItem.start))
      }
      if (stackItem.len > 1 && endStructsClock >= endClock) {
        getItemCleanStart(transaction, store, createID(doc.clientID, endClock))
      }

      iterateDeletedStructs(transaction, stackItem.ds, store, struct => {
        if (struct instanceof Item && scope.some(type => isParentOf(type, struct))) {
          if (!(struct.id.client === doc.clientID && struct.id.clock >= stackItem.start && struct.id.clock < stackItem.start + stackItem.len)) {
            itemsToRedo.add(struct)
          }
        }
      })
      itemsToRedo.forEach(item => {
        performedChange = redoItem(transaction, item, itemsToRedo) !== null || performedChange
      })
      /**
       * @type {Array<Item>}
       */
      const itemsToDelete = []
      iterateStructs(transaction, structs, stackItem.start, stackItem.len, struct => {
        if (struct instanceof Item && scope.some(type => isParentOf(type, /** @type {Item} */ (struct)))) {
          if (struct.redone !== null) {
            let { item, diff } = followRedone(store, struct.id)
            if (diff > 0) {
              item = getItemCleanStart(transaction, store, createID(item.id.client, item.id.clock + diff))
            }
            if (item.length > stackItem.len) {
              getItemCleanStart(transaction, store, createID(item.id.client, item.id.clock + stackItem.len))
            }
            struct = item
          }
          itemsToDelete.push(struct)
        }
      })
      // We want to delete in reverse order so that children are deleted before
      // parents, so we have more information available when items are filtered.
      for (let i = itemsToDelete.length - 1; i >= 0; i--) {
        const item = itemsToDelete[i]
        if (undoManager.deleteFilter(item)) {
          item.delete(transaction)
          performedChange = true
        }
      }
      result = stackItem
      if (result != null) {
        undoManager.emit('stack-item-popped', [{ stackItem: result, type: eventType }, undoManager])
      }
    }
  }, undoManager)
  return result
}

/**
 * @typedef {Object} UndoManagerOptions
 * @property {number} [UndoManagerOptions.captureTimeout=500]
 * @property {function(Item):boolean} [UndoManagerOptions.deleteFilter=()=>true] Sometimes
 * it is necessary to filter whan an Undo/Redo operation can delete. If this
 * filter returns false, the type/item won't be deleted even it is in the
 * undo/redo scope.
 * @property {Set<any>} [UndoManagerOptions.trackedOrigins=new Set([null])]
 */

/**
 * Fires 'stack-item-added' event when a stack item was added to either the undo- or
 * the redo-stack. You may store additional stack information via the
 * metadata property on `event.stackItem.metadata` (it is a `Map` of metadata properties).
 * Fires 'stack-item-popped' event when a stack item was popped from either the
 * undo- or the redo-stack. You may restore the saved stack information from `event.stackItem.metadata`.
 *
 * @extends {Observable<'stack-item-added'|'stack-item-popped'>}
 */
export class UndoManager extends Observable {
  /**
   * @param {AbstractType<any>|Array<AbstractType<any>>} typeScope Accepts either a single type, or an array of types
   * @param {UndoManagerOptions} options
   */
  constructor (typeScope, { captureTimeout, deleteFilter = () => true, trackedOrigins = new Set([null]) } = {}) {
    if (captureTimeout == null) {
      captureTimeout = 500
    }
    super()
    this.scope = typeScope instanceof Array ? typeScope : [typeScope]
    this.deleteFilter = deleteFilter
    trackedOrigins.add(this)
    this.trackedOrigins = trackedOrigins
    /**
     * @type {Array<StackItem>}
     */
    this.undoStack = []
    /**
     * @type {Array<StackItem>}
     */
    this.redoStack = []
    /**
     * Whether the client is currently undoing (calling UndoManager.undo)
     *
     * @type {boolean}
     */
    this.undoing = false
    this.redoing = false
    this.doc = /** @type {Doc} */ (this.scope[0].doc)
    this.lastChange = 0
    this.doc.on('afterTransaction', /** @param {Transaction} transaction */ transaction => {
      // Only track certain transactions
      if (!this.scope.some(type => transaction.changedParentTypes.has(type)) || (!this.trackedOrigins.has(transaction.origin) && (!transaction.origin || !this.trackedOrigins.has(transaction.origin.constructor)))) {
        return
      }
      const undoing = this.undoing
      const redoing = this.redoing
      const stack = undoing ? this.redoStack : this.undoStack
      if (undoing) {
        this.stopCapturing() // next undo should not be appended to last stack item
      } else if (!redoing) {
        // neither undoing nor redoing: delete redoStack
        this.redoStack = []
      }
      const beforeState = transaction.beforeState.get(this.doc.clientID) || 0
      const afterState = transaction.afterState.get(this.doc.clientID) || 0
      const now = time.getUnixTime()
      if (now - this.lastChange < captureTimeout && stack.length > 0 && !undoing && !redoing) {
        // append change to last stack op
        const lastOp = stack[stack.length - 1]
        lastOp.ds = mergeDeleteSets(lastOp.ds, transaction.deleteSet)
        lastOp.len = afterState - lastOp.start
      } else {
        // create a new stack op
        stack.push(new StackItem(transaction.deleteSet, beforeState, afterState - beforeState))
      }
      if (!undoing && !redoing) {
        this.lastChange = now
      }
      // make sure that deleted structs are not gc'd
      iterateDeletedStructs(transaction, transaction.deleteSet, transaction.doc.store, /** @param {Item|GC} item */ item => {
        if (item instanceof Item && this.scope.some(type => isParentOf(type, item))) {
          keepItem(item)
        }
      })
      this.emit('stack-item-added', [{ stackItem: stack[stack.length - 1], origin: transaction.origin, type: undoing ? 'redo' : 'undo' }, this])
    })
  }

  /**
   * UndoManager merges Undo-StackItem if they are created within time-gap
   * smaller than `options.captureTimeout`. Call `um.stopCapturing()` so that the next
   * StackItem won't be merged.
   *
   *
   * @example
   *     // without stopCapturing
   *     ytext.insert(0, 'a')
   *     ytext.insert(1, 'b')
   *     um.undo()
   *     ytext.toString() // => '' (note that 'ab' was removed)
   *     // with stopCapturing
   *     ytext.insert(0, 'a')
   *     um.stopCapturing()
   *     ytext.insert(0, 'b')
   *     um.undo()
   *     ytext.toString() // => 'a' (note that only 'b' was removed)
   *
   */
  stopCapturing () {
    this.lastChange = 0
  }

  /**
   * Undo last changes on type.
   *
   * @return {StackItem?} Returns StackItem if a change was applied
   */
  undo () {
    this.undoing = true
    let res
    try {
      res = popStackItem(this, this.undoStack, 'undo')
    } finally {
      this.undoing = false
    }
    return res
  }

  /**
   * Redo last undo operation.
   *
   * @return {StackItem?} Returns StackItem if a change was applied
   */
  redo () {
    this.redoing = true
    let res
    try {
      res = popStackItem(this, this.redoStack, 'redo')
    } finally {
      this.redoing = false
    }
    return res
  }
}

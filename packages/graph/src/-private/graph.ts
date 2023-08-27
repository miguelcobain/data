import { assert } from '@ember/debug';

import { LOG_GRAPH } from '@ember-data/debugging';
import { DEBUG } from '@ember-data/env';
import { MergeOperation } from '@ember-data/types/q/cache';
import type { CacheCapabilitiesManager } from '@ember-data/types/q/cache-store-wrapper';
import { CollectionResourceRelationship, SingleResourceRelationship } from '@ember-data/types/q/ember-data-json-api';
import type { StableRecordIdentifier } from '@ember-data/types/q/identifier';

import type { EdgeCache, UpgradedMeta } from './-edge-definition';
import { isLHS, upgradeDefinition } from './-edge-definition';
import type {
  DeleteRecordOperation,
  LocalRelationshipOperation,
  RemoteRelationshipOperation,
  UnknownOperation,
} from './-operations';
import {
  assertValidRelationshipPayload,
  forAllRelatedIdentifiers,
  getStore,
  isBelongsTo,
  isHasMany,
  isImplicit,
  isNew,
  notifyChange,
  removeIdentifierCompletelyFromRelationship,
} from './-utils';
import { type CollectionEdge, createCollectionEdge, legacyGetCollectionRelationshipData } from './edges/collection';
import { createImplicitEdge, ImplicitEdge, ImplicitMeta } from './edges/implicit';
import { createResourceEdge, legacyGetResourceRelationshipData, type ResourceEdge } from './edges/resource';
import addToRelatedRecords from './operations/add-to-related-records';
import { mergeIdentifier } from './operations/merge-identifier';
import removeFromRelatedRecords from './operations/remove-from-related-records';
import replaceRelatedRecord from './operations/replace-related-record';
import replaceRelatedRecords, { syncRemoteToLocal } from './operations/replace-related-records';
import updateRelationshipOperation from './operations/update-relationship';

export type GraphEdge = ImplicitEdge | CollectionEdge | ResourceEdge;

export const Graphs = new Map<CacheCapabilitiesManager, Graph>();

/*
 * Graph acts as the cache for relationship data. It allows for
 * us to ask about and update relationships for a given Identifier
 * without requiring other objects for that Identifier to be
 * instantiated (such as `RecordData` or a `Record`)
 *
 * This also allows for us to make more substantive changes to relationships
 * with increasingly minor alterations to other portions of the internals
 * over time.
 *
 * The graph is made up of nodes and edges. Each unique identifier gets
 * its own node, which is a dictionary with a list of that node's edges
 * (or connections) to other nodes. In `Model` terms, a node represents a
 * record instance, with each key (an edge) in the dictionary correlating
 * to either a `hasMany` or `belongsTo` field on that record instance.
 *
 * The value for each key, or `edge` is the identifier(s) the node relates
 * to in the graph from that key.
 */
export class Graph {
  declare _definitionCache: EdgeCache;
  declare _metaCache: Record<string, Record<string, UpgradedMeta>>;
  declare _potentialPolymorphicTypes: Record<string, Record<string, boolean>>;
  declare identifiers: Map<StableRecordIdentifier, Record<string, GraphEdge>>;
  declare store: CacheCapabilitiesManager;
  declare isDestroyed: boolean;
  declare _willSyncRemote: boolean;
  declare _willSyncLocal: boolean;
  declare _pushedUpdates: {
    belongsTo: RemoteRelationshipOperation[];
    hasMany: RemoteRelationshipOperation[];
    deletions: DeleteRecordOperation[];
  };
  declare _updatedRelationships: Set<CollectionEdge>;
  declare _transaction: Set<CollectionEdge | ResourceEdge> | null;
  declare _removing: StableRecordIdentifier | null;

  constructor(store: CacheCapabilitiesManager) {
    this._definitionCache = Object.create(null) as EdgeCache;
    this._metaCache = Object.create(null) as Record<string, Record<string, UpgradedMeta>>;
    this._potentialPolymorphicTypes = Object.create(null) as Record<string, Record<string, boolean>>;
    this.identifiers = new Map();
    this.store = store;
    this.isDestroyed = false;
    this._willSyncRemote = false;
    this._willSyncLocal = false;
    this._pushedUpdates = { belongsTo: [], hasMany: [], deletions: [] };
    this._updatedRelationships = new Set();
    this._transaction = null;
    this._removing = null;
  }

  has(identifier: StableRecordIdentifier, propertyName: string): boolean {
    let relationships = this.identifiers.get(identifier);
    if (!relationships) {
      return false;
    }
    return relationships[propertyName] !== undefined;
  }

  getDefinition(identifier: StableRecordIdentifier, propertyName: string): UpgradedMeta {
    let defs = this._metaCache[identifier.type];
    let meta: UpgradedMeta | null | undefined = defs?.[propertyName];
    if (!meta) {
      const info = /*#__NOINLINE__*/ upgradeDefinition(this, identifier, propertyName);
      assert(`Could not determine relationship information for ${identifier.type}.${propertyName}`, info !== null);

      // if (info.rhs_definition?.kind === 'implicit') {
      // we should possibly also do this
      // but it would result in being extremely permissive for other relationships by accident
      // this.registerPolymorphicType(info.rhs_baseModelName, identifier.type);
      // }

      meta = /*#__NOINLINE__*/ isLHS(info, identifier.type, propertyName) ? info.lhs_definition : info.rhs_definition!;
      defs = this._metaCache[identifier.type] = defs || {};
      defs[propertyName] = meta;
    }
    return meta;
  }

  get(identifier: StableRecordIdentifier, propertyName: string): GraphEdge {
    assert(`expected propertyName`, propertyName);
    let relationships = this.identifiers.get(identifier);
    if (!relationships) {
      relationships = Object.create(null) as Record<string, GraphEdge>;
      this.identifiers.set(identifier, relationships);
    }

    let relationship = relationships[propertyName];
    if (!relationship) {
      const meta = this.getDefinition(identifier, propertyName);

      if (meta.kind === 'belongsTo') {
        relationship = relationships[propertyName] = createResourceEdge(meta, identifier);
      } else if (meta.kind === 'hasMany') {
        relationship = relationships[propertyName] = createCollectionEdge(meta, identifier);
      } else {
        assert(`Expected kind to be implicit`, meta.kind === 'implicit' && meta.isImplicit === true);
        relationship = relationships[propertyName] = createImplicitEdge(meta as ImplicitMeta, identifier);
      }
    }

    return relationship;
  }

  getData(
    identifier: StableRecordIdentifier,
    propertyName: string
  ): SingleResourceRelationship | CollectionResourceRelationship {
    const relationship = this.get(identifier, propertyName);

    assert(`Cannot getData() on an implicit relationship`, !isImplicit(relationship));

    if (isBelongsTo(relationship)) {
      return legacyGetResourceRelationshipData(relationship);
    }

    return legacyGetCollectionRelationshipData(relationship);
  }

  /*
   * Allows for the graph to dynamically discover polymorphic connections
   * without needing to walk prototype chains.
   *
   * Used by edges when an added `type` does not match the expected `type`
   * for that edge.
   *
   * Currently we assert before calling this. For a public API we will want
   * to call out to the schema manager to ask if we should consider these
   * types as equivalent for a given relationship.
   */
  registerPolymorphicType(type1: string, type2: string): void {
    const typeCache = this._potentialPolymorphicTypes;
    let t1 = typeCache[type1];
    if (!t1) {
      t1 = typeCache[type1] = Object.create(null) as Record<string, boolean>;
    }
    t1[type2] = true;

    let t2 = typeCache[type2];
    if (!t2) {
      t2 = typeCache[type2] = Object.create(null) as Record<string, boolean>;
    }
    t2[type1] = true;
  }

  /*
   TODO move this comment somewhere else
   implicit relationships are relationships which have not been declared but the inverse side exists on
   another record somewhere

   For example if there was:

   ```app/models/comment.js
   import Model, { attr } from '@ember-data/model';

   export default class Comment extends Model {
     @attr text;
   }
   ```

   and there is also:

   ```app/models/post.js
   import Model, { attr, hasMany } from '@ember-data/model';

   export default class Post extends Model {
     @attr title;
     @hasMany('comment', { async: true, inverse: null }) comments;
   }
   ```

   Then we would have a implicit 'post' relationship for the comment record in order
   to be do things like remove the comment from the post if the comment were to be deleted.
  */

  isReleasable(identifier: StableRecordIdentifier): boolean {
    const relationships = this.identifiers.get(identifier);
    if (!relationships) {
      if (LOG_GRAPH) {
        // eslint-disable-next-line no-console
        console.log(`graph: RELEASABLE ${String(identifier)}`);
      }
      return true;
    }
    const keys = Object.keys(relationships);
    for (let i = 0; i < keys.length; i++) {
      const relationship: GraphEdge = relationships[keys[i]];
      // account for previously unloaded relationships
      // typically from a prior deletion of a record that pointed to this one implicitly
      if (relationship === undefined) {
        continue;
      }
      assert(`Expected a relationship`, relationship);
      if (relationship.definition.inverseIsAsync && !isNew(identifier)) {
        if (LOG_GRAPH) {
          // eslint-disable-next-line no-console
          console.log(`graph: <<NOT>> RELEASABLE ${String(identifier)}`);
        }
        return false;
      }
    }
    if (LOG_GRAPH) {
      // eslint-disable-next-line no-console
      console.log(`graph: RELEASABLE ${String(identifier)}`);
    }
    return true;
  }

  unload(identifier: StableRecordIdentifier, silenceNotifications?: boolean) {
    if (LOG_GRAPH) {
      // eslint-disable-next-line no-console
      console.log(`graph: unload ${String(identifier)}`);
    }
    const relationships = this.identifiers.get(identifier);

    if (relationships) {
      // cleans up the graph but retains some nodes
      // to allow for rematerialization
      Object.keys(relationships).forEach((key) => {
        let rel = relationships[key]!;
        if (!rel) {
          return;
        }
        /*#__NOINLINE__*/ destroyRelationship(this, rel, silenceNotifications);
        if (/*#__NOINLINE__*/ isImplicit(rel)) {
          // @ts-expect-error
          relationships[key] = undefined;
        }
      });
    }
  }

  remove(identifier: StableRecordIdentifier) {
    if (LOG_GRAPH) {
      // eslint-disable-next-line no-console
      console.log(`graph: remove ${String(identifier)}`);
    }
    assert(`Cannot remove ${String(identifier)} while still removing ${String(this._removing)}`, !this._removing);
    this._removing = identifier;
    this.unload(identifier);
    this.identifiers.delete(identifier);
    this._removing = null;
  }

  /*
   * Remote state changes
   */
  push(op: RemoteRelationshipOperation) {
    if (LOG_GRAPH) {
      // eslint-disable-next-line no-console
      console.log(`graph: push ${String(op.record)}`, op);
    }
    if (op.op === 'deleteRecord') {
      this._pushedUpdates.deletions.push(op);
    } else if (op.op === 'replaceRelatedRecord') {
      this._pushedUpdates.belongsTo.push(op);
    } else {
      const definition = this.getDefinition(op.record, op.field);
      assert(`Cannot push a remote update for an implicit relationship`, definition.kind !== 'implicit');
      this._pushedUpdates[definition.kind].push(op);
    }
    if (!this._willSyncRemote) {
      this._willSyncRemote = true;
      getStore(this.store)._schedule('coalesce', () => this._flushRemoteQueue());
    }
  }

  /*
   * Local state changes
   */
  update(op: RemoteRelationshipOperation | MergeOperation, isRemote: true): void;
  update(op: LocalRelationshipOperation, isRemote?: false): void;
  update(
    op: MergeOperation | LocalRelationshipOperation | RemoteRelationshipOperation | UnknownOperation,
    isRemote: boolean = false
  ): void {
    assert(
      `Cannot update an implicit relationship`,
      op.op === 'deleteRecord' || op.op === 'mergeIdentifiers' || !isImplicit(this.get(op.record, op.field))
    );
    if (LOG_GRAPH) {
      // eslint-disable-next-line no-console
      console.log(`graph: update (${isRemote ? 'remote' : 'local'}) ${String(op.record)}`, op);
    }

    switch (op.op) {
      case 'mergeIdentifiers': {
        const relationships = this.identifiers.get(op.record);
        if (relationships) {
          /*#__NOINLINE__*/ mergeIdentifier(this, op, relationships);
        }
        break;
      }
      case 'updateRelationship':
        assert(`Can only perform the operation updateRelationship on remote state`, isRemote);
        if (DEBUG) {
          // in debug, assert payload validity eagerly
          // TODO add deprecations/assertion here for duplicates
          assertValidRelationshipPayload(this, op);
        }
        /*#__NOINLINE__*/ updateRelationshipOperation(this, op);
        break;
      case 'deleteRecord': {
        assert(`Can only perform the operation deleteRelationship on remote state`, isRemote);
        const identifier = op.record;
        const relationships = this.identifiers.get(identifier);

        if (relationships) {
          Object.keys(relationships).forEach((key) => {
            const rel = relationships[key];
            if (!rel) {
              return;
            }
            // works together with the has check
            // @ts-expect-error
            relationships[key] = undefined;
            /*#__NOINLINE__*/ removeCompletelyFromInverse(this, rel);
          });
          this.identifiers.delete(identifier);
        }
        break;
      }
      case 'replaceRelatedRecord':
        /*#__NOINLINE__*/ replaceRelatedRecord(this, op, isRemote);
        break;
      case 'addToRelatedRecords':
        // we will lift this restriction once the cache is allowed to make remote updates directly
        assert(`Can only perform the operation addToRelatedRecords on local state`, !isRemote);
        /*#__NOINLINE__*/ addToRelatedRecords(this, op, isRemote);
        break;
      case 'removeFromRelatedRecords':
        // we will lift this restriction once the cache is allowed to make remote updates directly
        assert(`Can only perform the operation removeFromRelatedRecords on local state`, !isRemote);
        /*#__NOINLINE__*/ removeFromRelatedRecords(this, op, isRemote);
        break;
      case 'replaceRelatedRecords':
        /*#__NOINLINE__*/ replaceRelatedRecords(this, op, isRemote);
        break;
      default:
        assert(`No local relationship update operation exists for '${op.op}'`);
    }
  }

  _scheduleLocalSync(relationship: CollectionEdge) {
    this._updatedRelationships.add(relationship);
    if (!this._willSyncLocal) {
      this._willSyncLocal = true;
      getStore(this.store)._schedule('sync', () => this._flushLocalQueue());
    }
  }

  _flushRemoteQueue() {
    if (!this._willSyncRemote) {
      return;
    }
    if (LOG_GRAPH) {
      // eslint-disable-next-line no-console
      console.groupCollapsed(`Graph: Initialized Transaction`);
    }
    this._transaction = new Set();
    this._willSyncRemote = false;
    const { deletions, hasMany, belongsTo } = this._pushedUpdates;
    this._pushedUpdates.deletions = [];
    this._pushedUpdates.hasMany = [];
    this._pushedUpdates.belongsTo = [];

    for (let i = 0; i < deletions.length; i++) {
      this.update(deletions[i], true);
    }

    for (let i = 0; i < hasMany.length; i++) {
      this.update(hasMany[i], true);
    }

    for (let i = 0; i < belongsTo.length; i++) {
      this.update(belongsTo[i], true);
    }
    this._finalize();
  }

  _addToTransaction(relationship: CollectionEdge | ResourceEdge) {
    assert(`expected a transaction`, this._transaction !== null);
    if (LOG_GRAPH) {
      // eslint-disable-next-line no-console
      console.log(`Graph: ${String(relationship.identifier)} ${relationship.definition.key} added to transaction`);
    }
    relationship.transactionRef++;
    this._transaction.add(relationship);
  }

  _finalize() {
    if (this._transaction) {
      this._transaction.forEach((v) => (v.transactionRef = 0));
      this._transaction = null;
      if (LOG_GRAPH) {
        // eslint-disable-next-line no-console
        console.log(`Graph: transaction finalized`);
        // eslint-disable-next-line no-console
        console.groupEnd();
      }
    }
  }

  _flushLocalQueue() {
    if (!this._willSyncLocal) {
      return;
    }
    this._willSyncLocal = false;
    let updated = this._updatedRelationships;
    this._updatedRelationships = new Set();
    updated.forEach((rel) => /*#__NOINLINE__*/ syncRemoteToLocal(this, rel));
  }

  destroy() {
    Graphs.delete(this.store);

    if (DEBUG) {
      Graphs.delete(getStore(this.store) as unknown as CacheCapabilitiesManager);
      if (Graphs.size) {
        Graphs.forEach((_, key) => {
          assert(
            `Memory Leak Detected, likely the test or app instance previous to this was not torn down properly`,
            // @ts-expect-error
            !key.isDestroyed && !key.isDestroying
          );
        });
      }
    }

    this.identifiers.clear();
    this.store = null as unknown as CacheCapabilitiesManager;
    this.isDestroyed = true;
  }
}

// Handle dematerialization for relationship `rel`.  In all cases, notify the
// relationship of the dematerialization: this is done so the relationship can
// notify its inverse which needs to update state
//
// If the inverse is sync, unloading this record is treated as a client-side
// delete, so we remove the inverse records from this relationship to
// disconnect the graph.  Because it's not async, we don't need to keep around
// the identifier as an id-wrapper for references
function destroyRelationship(graph: Graph, rel: GraphEdge, silenceNotifications?: boolean) {
  if (isImplicit(rel)) {
    if (graph.isReleasable(rel.identifier)) {
      /*#__NOINLINE__*/ removeCompletelyFromInverse(graph, rel);
    }
    return;
  }

  const { identifier } = rel;
  const { inverseKey } = rel.definition;

  if (!rel.definition.inverseIsImplicit) {
    /*#__NOINLINE__*/ forAllRelatedIdentifiers(rel, (inverseIdentifer: StableRecordIdentifier) =>
      /*#__NOINLINE__*/ notifyInverseOfDematerialization(
        graph,
        inverseIdentifer,
        inverseKey,
        identifier,
        silenceNotifications
      )
    );
  }

  if (!rel.definition.inverseIsImplicit && !rel.definition.inverseIsAsync) {
    rel.state.isStale = true;
    /*#__NOINLINE__*/ clearRelationship(rel);

    // necessary to clear relationships in the ui from dematerialized records
    // hasMany is managed by Model which calls `retreiveLatest` after
    // dematerializing the resource-cache instance.
    // but sync belongsTo requires this since they don't have a proxy to update.
    // so we have to notify so it will "update" to null.
    // we should discuss whether we still care about this, probably fine to just
    // leave the ui relationship populated since the record is destroyed and
    // internally we've fully cleaned up.
    if (!rel.definition.isAsync && !silenceNotifications) {
      /*#__NOINLINE__*/ notifyChange(graph, rel.identifier, rel.definition.key);
    }
  }
}

function notifyInverseOfDematerialization(
  graph: Graph,
  inverseIdentifier: StableRecordIdentifier,
  inverseKey: string,
  identifier: StableRecordIdentifier,
  silenceNotifications?: boolean
) {
  if (!graph.has(inverseIdentifier, inverseKey)) {
    return;
  }

  let relationship = graph.get(inverseIdentifier, inverseKey);
  assert(`expected no implicit`, !isImplicit(relationship));

  // For remote members, it is possible that inverseRecordData has already been associated to
  // to another record. For such cases, do not dematerialize the inverseRecordData
  if (!isBelongsTo(relationship) || !relationship.localState || identifier === relationship.localState) {
    /*#__NOINLINE__*/ removeDematerializedInverse(graph, relationship, identifier, silenceNotifications);
  }
}

function clearRelationship(relationship: CollectionEdge | ResourceEdge) {
  if (isBelongsTo(relationship)) {
    relationship.localState = null;
    relationship.remoteState = null;
    relationship.state.hasReceivedData = false;
    relationship.state.isEmpty = true;
  } else {
    relationship.localMembers.clear();
    relationship.remoteMembers.clear();
    relationship.localState = [];
    relationship.remoteState = [];
  }
}

function removeDematerializedInverse(
  graph: Graph,
  relationship: CollectionEdge | ResourceEdge,
  inverseIdentifier: StableRecordIdentifier,
  silenceNotifications?: boolean
) {
  if (isBelongsTo(relationship)) {
    const localInverse = relationship.localState;
    if (!relationship.definition.isAsync || (localInverse && isNew(localInverse))) {
      // unloading inverse of a sync relationship is treated as a client-side
      // delete, so actually remove the models don't merely invalidate the cp
      // cache.
      // if the record being unloaded only exists on the client, we similarly
      // treat it as a client side delete
      if (relationship.localState === localInverse && localInverse !== null) {
        relationship.localState = null;
      }

      if (relationship.remoteState === localInverse && localInverse !== null) {
        relationship.remoteState = null;
        relationship.state.hasReceivedData = true;
        relationship.state.isEmpty = true;
        if (relationship.localState && !isNew(relationship.localState)) {
          relationship.localState = null;
        }
      }
    } else {
      relationship.state.hasDematerializedInverse = true;
    }

    if (!silenceNotifications) {
      notifyChange(graph, relationship.identifier, relationship.definition.key);
    }
  } else {
    if (!relationship.definition.isAsync || (inverseIdentifier && isNew(inverseIdentifier))) {
      // unloading inverse of a sync relationship is treated as a client-side
      // delete, so actually remove the models don't merely invalidate the cp
      // cache.
      // if the record being unloaded only exists on the client, we similarly
      // treat it as a client side delete
      /*#__NOINLINE__*/ removeIdentifierCompletelyFromRelationship(graph, relationship, inverseIdentifier);
    } else {
      relationship.state.hasDematerializedInverse = true;
    }

    if (!silenceNotifications) {
      notifyChange(graph, relationship.identifier, relationship.definition.key);
    }
  }
}

function removeCompletelyFromInverse(graph: Graph, relationship: GraphEdge) {
  const { identifier } = relationship;
  const { inverseKey } = relationship.definition;

  forAllRelatedIdentifiers(relationship, (inverseIdentifier: StableRecordIdentifier) => {
    if (graph.has(inverseIdentifier, inverseKey)) {
      removeIdentifierCompletelyFromRelationship(graph, graph.get(inverseIdentifier, inverseKey), identifier);
    }
  });

  if (isBelongsTo(relationship)) {
    if (!relationship.definition.isAsync) {
      clearRelationship(relationship);
    }

    relationship.localState = null;
  } else if (isHasMany(relationship)) {
    if (!relationship.definition.isAsync) {
      clearRelationship(relationship);

      notifyChange(graph, relationship.identifier, relationship.definition.key);
    }
  } else {
    relationship.remoteMembers.clear();
    relationship.localMembers.clear();
  }
}
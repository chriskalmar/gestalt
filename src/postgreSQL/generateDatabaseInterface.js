// Generates an internal representation of a PostgreSQL schema from a GraphQL
// type definition AST.
// @flow

import type {Document, Node, ObjectTypeDefinition, FieldDefinition, Directive,
  Type, NamedType, DatabaseInterface, DatabaseSchema, Table, Index, Column,
  ColumnType, Relationship, RelationshipSegment, RelationshipSegmentPair,
  JoinTableDescription, ForeignKeyDescription, RelationshipSegmentDescription}
  from '../types';
import {plural} from 'pluralize';
import {snake} from 'change-case';
import resolveNode from './resolveNode';
import {generateRelationshipResolver, generateRelationshipLoaders} from
  './generateRelationshipResolver';
import {invariant, keyMap, baseType} from '../util';
import * as db from '../PostgreSQL/db';

export default function generateDatabaseInterface(
  ast: Document
): DatabaseInterface {
  const tables: Table[] = [];
  const tablesByName: {[key: string]: Table} = {};
  const indices: Index[] = [];
  const relationships: Relationship[] = [];

  // create tables and indexes for object types, take inventory of relationships
  ast.definitions.forEach(definition => {
    if (isDatabaseType(definition)) {
      const table = tableFromObjectTypeDefinition(definition);
      tablesByName[table.name] = table;
      tables.push(table);

      indices.push(idIndexFromObjectTypeDefinition(definition));
      relationships.push(...relationshipsFromObjectTypeDefinition(definition));
    }
  });

  // having looked at each type and recorded their relationships, we create
  // normalized descriptions of their relationships
  const segmentDescriptions = segmentDescriptionsFromRelationships(
    relationships
  );
  const segmentDescriptionsBySignature = keyMap(
    segmentDescriptions,
    segment => segment.signature
  );

  // create join tables, foreign key columns, and indices based on the
  // relationship descriptions
  segmentDescriptions.forEach(segment => {
    if (segment.type === 'join') {
      // add join table and indices
      tables.push(joinTableFromDescription(segment.storage));
      indices.push(...joinTableIndicesFromDescription(segment.storage));
    } else {
      // add foreign key and index
      const table = tablesByName[segment.storage.table];
      table.columns.push(columnFromForeignKeyDescription(segment.storage));
      indices.push(indexFromForeignKeyDescription(segment.storage));
    }
  });

  return {
    db,
    schema: {
      tables,
      indices,
    },
    relationships,
    resolveNode,
    generateRelationshipResolver: generateRelationshipResolver(
      segmentDescriptionsBySignature
    ),
    generateRelationshipLoaders: generateRelationshipLoaders(
      segmentDescriptionsBySignature,
      relationships
    ),
  };
}

export function isDatabaseType(definition: Node): boolean {
  // Only ObjectTypes implementing the Node interface are recorded
  return (
    definition.kind === 'ObjectTypeDefinition' &&
    definition.interfaces.some(type => type.name.value === 'Node')
  );
}

export function isDatabaseField(definition: FieldDefinition): boolean {
  // Fields with the @virtual directive are not recorded, fields with the
  // @relationship directive generate join tables or foreign keys which are
  // added seperately
  return (
    !definition.directives ||
    !definition.directives.some(
      d => d.name.value === 'virtual' || d.name.value === 'relationship'
    )
  );
}

export function isNonNullType(type: Type): boolean {
  return type.kind === 'NonNullType';
}

export function isListType(type: Type): boolean {
  return (
    type.kind === 'ListType' ||
    (type.kind === 'NonNullType' && type.type.kind === 'ListType')
  );
}

export function tableFromObjectTypeDefinition(
  definition: ObjectTypeDefinition,
): Table {
  const name = tableNameFromTypeName(definition.name.value);
  const columns = [];

  definition.fields.forEach(field => {
    if (isDatabaseField(field)) {
      columns.push(columnFromFieldDefintion(field));
    }
  });

  return {name, columns};
}

export function columnFromFieldDefintion(definition: FieldDefinition): Column {
  return {
    name: snake(definition.name.value),
    type: columnTypeFromGraphQLType(definition.type),
    primaryKey: definition.name.value === 'id',
    nonNull: isNonNullType(definition.type),
  };
}

export function columnTypeFromGraphQLType(type: Type): ColumnType {
  if (type.isListType) {
    return 'jsonb';
  }

  switch (baseType(type).name.value) {
    case 'ID':
      return 'uuid';
    case 'String':
      return 'varchar(255)';
    case 'Int':
      return 'integer';
    case 'Float':
      return 'double precision';
    case 'Text':
      return 'text';
    case 'Date':
      return 'timestamp';
    case 'Money':
      return 'money';
    default:
      return 'jsonb';
  }
}

export function idIndexFromObjectTypeDefinition(
  definition: ObjectTypeDefinition,
): Index {
  return {
    table: tableNameFromTypeName(definition.name.value),
    columns: ['id'],
  };
}

export function relationshipsFromObjectTypeDefinition(
  definition: ObjectTypeDefinition,
): [Relationship] {
  const fromType = definition.name.value;
  const relationships = [];

  definition.fields.forEach(field => {
    if (field.directives) {
      const relationshipDirective = field.directives.find(
        d => d.name.value === 'relationship'
      );
      if (relationshipDirective) {
        invariant(
          !isListType(field.type),
          'relationships cannot be list types'
        );
        const fieldName = field.name.value;
        const nonNull = isNonNullType(field.type);
        const toType = baseType(field.type).name.value;
        relationships.push(
          relationshipFromDirective(
            fieldName,
            fromType,
            toType,
            nonNull,
            relationshipDirective
          )
        );
      }
    }
  });

  return relationships;
}

export function relationshipFromDirective(
  fieldName: string,
  fromType: string,
  toType: string,
  nonNull: boolean,
  directive: Directive
): Relationship {
  const pathArgument = directive.arguments.find(
    argument => argument.name.value === 'path'
  );

  return relationshipFromPathString(
    fieldName,
    fromType,
    toType,
    nonNull,
    pathArgument.value.value
  );
}

export function relationshipFromPathString(
  fieldName: string,
  initialType: string,
  finalType: string,
  nonNull: boolean,
  pathString: string,
): Relationship {
  const parts = pathString.split(/([A-Za-z_]+)/);
  const path = [];
  let fromType = initialType;

  while (parts.length > 3) {
    const [left, label, right, toType] = parts.splice(0, 4);
    path.push(
      relationshipSegmentFromParts(fromType, left, label, right, toType)
    );
    fromType = toType;
  }

  const [left, label, right] = parts;
  path.push(
    relationshipSegmentFromParts(
      fromType,
      left,
      label,
      right,
      finalType,
      nonNull
    )
  );

  invariant(
    !nonNull || path.length === 1 && path[0].cardinality === 'singular',
    'Only singular relationships with one segment can be non null'
  );

  const cardinality = (
    path.some(segment => segment.cardinality === 'plural')
    ? 'plural'
    : 'singular'
  );

  return {
    fieldName,
    path,
    cardinality,
  };
}

const ARROWS = {
  '-->': {cardinality: 'singular', direction: 'out'},
  '<--': {cardinality: 'singular', direction: 'in'},
  '==>': {cardinality: 'plural', direction: 'out'},
  '<==': {cardinality: 'plural', direction: 'in'},
};

export function relationshipSegmentFromParts(
  fromType: string,
  left: string,
  label: string,
  right: string,
  toType: string,
  nonNull: boolean = false
): RelationshipSegment {
  const arrow = ARROWS[left + right];
  invariant(arrow, 'invalid path string');
  return Object.assign({fromType, toType, label, nonNull}, arrow);
}

export function segmentDescriptionsFromRelationships(
  relationships: [Relationship]
): RelationshipSegmentDescription[] {
  const segments = flattenedUniqueSegmentsFromRelationships(relationships);

  // create map of segments by taking their signature along the relationship
  // direction
  const segmentMap: {[key: string]: RelationshipSegment[]} = {};
  segments.forEach(segment => {
    const signature = pairingSignatureFromRelationshipSegment(segment);
    segmentMap[signature] = (segmentMap[signature] || []).concat(segment);
  });

  // create RelationshipSegmentDescription objects
  return Object.entries(segmentMap).map(([signature, segments]) => {
    const pair = {};
    segments.forEach(segment => pair[segment.direction] = segment);

    const isJoin = segmentPairRequiresJoinTable(pair);
    const type = isJoin ? 'join' : 'foreignKey';
    const storage = (
      isJoin
      ? joinTableDescriptionFromRelationshipSegmentPair(pair)
      : foreignKeyDescriptionFromRelationshipSegmentPair(pair)
    );

    return {
      type,
      signature,
      pair,
      storage
    };
  });
}

export function pairingSignatureFromRelationshipSegment(
  segment: RelationshipSegment
): string {
  const {fromType, toType, label, direction} = segment;
  return (
    (direction === 'in')
    ? `${toType}|${label}|${fromType}`
    : `${fromType}|${label}|${toType}`
  );
}

export function flattenedUniqueSegmentsFromRelationships(
  relationships: Relationship[]
): RelationshipSegment[] {
  const segmentMap: {[key: string]: RelationshipSegment} = {};
  relationships.forEach(relationship =>
    relationship.path.forEach(segment => {
      const signature = identitySignatureFromRelationshipSegment(segment);
      if (segmentMap[signature] == null || !segmentMap[signature].nonNull) {
        segmentMap[signature] = segment;
      }
    })
  );

  return Object.values(segmentMap);
}

export function identitySignatureFromRelationshipSegment(
  segment: RelationshipSegment
): string {
  const {fromType, toType, label, direction} = segment;
  return [fromType, toType, label, direction].join('|');
}

export function segmentPairRequiresJoinTable(
  pair: RelationshipSegmentPair
): boolean {
  return (
    (pair.in == null || pair.in.cardinality === 'plural') &&
    (pair.out == null || pair.out.cardinality === 'plural')
  );
}

export function joinTableDescriptionFromRelationshipSegmentPair(
  pair: RelationshipSegmentPair
): JoinTableDescription {
  invariant(
    pair.out || pair.in,
    'relationship segment pair must have at least one segment'
  );
  const left = (pair.out && pair.out.fromType) || (pair.in && pair.in.toType);
  const right = (pair.out && pair.out.toType) || (pair.in && pair.in.fromType);
  const label = (pair.out && pair.out.label) || (pair.in && pair.in.label);

  return {
    name: tableNameFromTypeName(`${left}_${label}_${right}`),
    leftTableName: tableNameFromTypeName(left),
    rightTableName: tableNameFromTypeName(right),
    leftColumnName: snake(`${left}_id`),
    rightColumnName: snake(`${label}_${right}_id`),
  };
}

export function joinTableFromDescription(
  description: JoinTableDescription
): Table {
  const {name, leftTableName, rightTableName, leftColumnName,
    rightColumnName} = description;

  return {
    name,
    columns: [
      {
        name: leftColumnName,
        type: 'uuid',
        nonNull: true,
        primaryKey: false,
        references: {
          table: leftTableName,
          column: 'id',
        }
      },
      {
        name: rightColumnName,
        type: 'uuid',
        nonNull: true,
        primaryKey: false,
        references: {
          table: rightTableName,
          column: 'id',
        },
      },
    ],
    constraints: [
      {
        type: 'unique',
        columns: [leftColumnName, rightColumnName],
      },
    ],
  };
}

export function joinTableIndicesFromDescription(
  description: JoinTableDescription
): Index[] {
  const {name, leftTableName, rightTableName, leftColumnName,
    rightColumnName} = description;

  return [
    {
      table: name,
      columns: [leftColumnName],
    },
    {
      table: name,
      columns: [rightColumnName],
    }
  ];
}

// when considering a segment pair we will use a foreign key if one or both of
// the segments are singular. We decide on which of the two tables to put the
// foreign key using the following rules:

// missing + singular:
//   - add the column to the out type of the existing segment
// singular + plural:
//   - add the column to the fromType of the singular segment
// singular + singular:
//   - if one segment is non null, add the column to its fromType, otherwise
//     add it to the toType of the out segment.

export function foreignKeyDescriptionFromRelationshipSegmentPair(
  pair: RelationshipSegmentPair
): ForeignKeyDescription {
  const normalType = (
    pair.in && (
      (pair.out == null) ||
      (pair.in.cardinality === 'plural') ||
      (pair.out.nonNull && !pair.in.nonNull)
    )
    ? pair.in
    : pair.out
  );

  invariant(normalType, 'input pair does not require a foreign key');
  const {label, fromType, toType, direction} = normalType;

  return {
    direction,
    nonNull: (
      (pair.out != null && pair.out.nonNull) ||
      (pair.in != null && pair.in.nonNull)
    ),
    table: tableNameFromTypeName(toType),
    referencedTable: tableNameFromTypeName(fromType),
    column: snake(
      (direction === 'in')
      ? `${label}_${fromType}_id`
      : `${label}_by_${fromType}_id`
    ),
  };
}

export function indexFromForeignKeyDescription(
  description: ForeignKeyDescription
): Index {
  return {
    table: description.table,
    columns: [description.column]
  };
}

export function columnFromForeignKeyDescription(
  description: ForeignKeyDescription
): Column {
  return {
    name: description.column,
    type: 'uuid',
    primaryKey: false,
    nonNull: description.nonNull,
    references: {
      table: description.referencedTable,
      column: 'id'
    },
  };
}

export function tableNameFromTypeName(typeName: string): string {
  return snake(plural(typeName));
}
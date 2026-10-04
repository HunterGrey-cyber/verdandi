import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fromBinary, isFieldSet } from '@bufbuild/protobuf';
import {
  FieldDescriptorProto_Label,
  FieldDescriptorProto_Type,
  FieldDescriptorProtoSchema,
  FileDescriptorSetSchema,
  type DescriptorProto,
  type EnumDescriptorProto,
  type FileDescriptorProto,
} from '@bufbuild/protobuf/wkt';

/**
 * A proto breaking-change checker, small enough to read in one sitting.
 *
 * WHICH TOOL, AND WHY. `buf breaking` is the obvious one and is on the maintainer's machine, but it is
 * a Go binary that `npm ci` cannot install, and these tests also have to pass in the public export
 * (a tree that carries only what `npm` and `cargo` bring). So this uses what the build already
 * runs: the `protoc` that ships inside `grpc-tools` (the same one `npm run generate` calls) to turn
 * each .proto into a FileDescriptorSet, decoded with `@bufbuild/protobuf` -- which the generated
 * clients already import. protoc's own parse is the ground truth; nothing here parses .proto text.
 * `buf breaking` (1.72) was used once, by hand, as an independent oracle when this file was written:
 * it returned the same verdict as this checker on all 30 mutations in protoMutations.ts (21 breaking,
 * 9 harmless).
 *
 * WHAT COUNTS AS BREAKING. The contract is "a client generated from the FROZEN proto keeps working
 * against the CURRENT one", so the current proto has to be the frozen one plus additions:
 *
 *   - a message, enum, enum value, service or method of the frozen proto is gone or changed;
 *   - a field number is gone, renamed, retyped, re-labelled (singular / repeated / optional) or moved
 *     in or out of a oneof;
 *   - a tag or name the frozen proto reserved is used again, or is no longer reserved;
 *   - the package changed.
 *
 * Renames are included although field names do not travel on the binary wire: generated code is
 * written against names, and a host that bumps its pin must not find a field gone. That is buf's own
 * FILE category. Packed-ness is deliberately NOT a rule: parsers must accept both encodings.
 *
 * WHAT IS REPORTED AS AN ADDITION. Everything the other way round. Additions are not errors, but they
 * are listed, because the next step (a `protocol_minor` bump per additive change) needs exactly that
 * list.
 */

export type FieldModel = {
  name: string;
  number: number;
  type: string;
  typeName: string;
  label: 'optional' | 'required' | 'repeated';
  oneof: string | undefined;
  proto3Optional: boolean;
};

export type MessageModel = {
  fullName: string;
  fields: Map<number, FieldModel>;
  oneofs: string[];
  /** Inclusive on both ends, unlike the descriptor's exclusive end. */
  reservedRanges: Array<[number, number]>;
  reservedNames: string[];
};

export type EnumModel = {
  fullName: string;
  values: Map<number, string[]>;
  reservedRanges: Array<[number, number]>;
  reservedNames: string[];
};

export type MethodModel = { name: string; input: string; output: string; clientStreaming: boolean; serverStreaming: boolean };

export type ProtoModel = {
  package: string;
  syntax: string;
  messages: Map<string, MessageModel>;
  enums: Map<string, EnumModel>;
  services: Map<string, Map<string, MethodModel>>;
};

/** The protoc that `npm run generate` uses, found through the package rather than through PATH. */
export function bundledProtoc(): string {
  const manifest = createRequire(import.meta.url).resolve('grpc-tools/package.json');
  const protoc = join(dirname(manifest), 'bin', 'protoc');
  if (!existsSync(protoc)) {
    throw new Error(`grpc-tools' protoc is not at ${protoc}; run \`npm ci\``);
  }
  return protoc;
}

/** protoc's own parse of one .proto file, as a FileDescriptorProto. */
export function compileProto(protoPath: string): FileDescriptorProto {
  const dir = mkdtempSync(join(tmpdir(), 'proto-model-'));
  try {
    const out = join(dir, 'set.bin');
    execFileSync(bundledProtoc(), [`--descriptor_set_out=${out}`, `--proto_path=${dirname(protoPath)}`, basename(protoPath)], { stdio: ['ignore', 'ignore', 'pipe'] });
    const set = fromBinary(FileDescriptorSetSchema, readFileSync(out));
    if (set.file.length !== 1) {
      throw new Error(`expected exactly one file in the descriptor set, got ${set.file.length}`);
    }
    return set.file[0];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The same, for proto source text (used to mutate the frozen proto in memory). */
export function compileProtoText(text: string): FileDescriptorProto {
  const dir = mkdtempSync(join(tmpdir(), 'proto-text-'));
  try {
    const path = join(dir, 'runtime.proto');
    writeFileSync(path, text);
    return compileProto(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function typeName(type: FieldDescriptorProto_Type): string {
  return (FieldDescriptorProto_Type[type] ?? `type${type}`).toLowerCase();
}

function labelOf(label: FieldDescriptorProto_Label): FieldModel['label'] {
  switch (label) {
    case FieldDescriptorProto_Label.REPEATED:
      return 'repeated';
    case FieldDescriptorProto_Label.REQUIRED:
      return 'required';
    default:
      return 'optional';
  }
}

function addMessage(into: ProtoModel, prefix: string, message: DescriptorProto): void {
  const fullName = `${prefix}.${message.name}`;
  const oneofs = message.oneofDecl.map((decl) => decl.name);
  const fields = new Map<number, FieldModel>();
  for (const field of message.field) {
    fields.set(field.number, {
      name: field.name,
      number: field.number,
      type: typeName(field.type),
      typeName: field.typeName,
      label: labelOf(field.label),
      // A proto3 `optional` is a synthetic single-field oneof in the descriptor; it is reported as
      // `proto3Optional` instead, so moving a field in or out of a REAL oneof is the only oneof change.
      // `oneofIndex` has presence; protobuf-es reads an unset one as 0, which is the first oneof.
      oneof: isFieldSet(field, FieldDescriptorProtoSchema.field.oneofIndex) && !field.proto3Optional ? oneofs[field.oneofIndex] : undefined,
      proto3Optional: field.proto3Optional === true,
    });
  }
  into.messages.set(fullName, {
    fullName,
    fields,
    oneofs: message.oneofDecl
      .filter((_, index) => message.field.some((f) => isFieldSet(f, FieldDescriptorProtoSchema.field.oneofIndex) && f.oneofIndex === index && !f.proto3Optional))
      .map((decl) => decl.name),
    reservedRanges: message.reservedRange.map((range): [number, number] => [range.start, range.end - 1]),
    reservedNames: [...message.reservedName],
  });
  for (const nested of message.nestedType) {
    addMessage(into, fullName, nested);
  }
  for (const nested of message.enumType) {
    addEnum(into, fullName, nested);
  }
}

function addEnum(into: ProtoModel, prefix: string, enumeration: EnumDescriptorProto): void {
  const fullName = `${prefix}.${enumeration.name}`;
  const values = new Map<number, string[]>();
  for (const value of enumeration.value) {
    values.set(value.number, [...(values.get(value.number) ?? []), value.name]);
  }
  into.enums.set(fullName, {
    fullName,
    values,
    reservedRanges: enumeration.reservedRange.map((range): [number, number] => [range.start, range.end]),
    reservedNames: [...enumeration.reservedName],
  });
}

export function modelOf(file: FileDescriptorProto): ProtoModel {
  const model: ProtoModel = { package: file.package, syntax: file.syntax, messages: new Map(), enums: new Map(), services: new Map() };
  for (const message of file.messageType) {
    addMessage(model, file.package, message);
  }
  for (const enumeration of file.enumType) {
    addEnum(model, file.package, enumeration);
  }
  for (const service of file.service) {
    model.services.set(
      `${file.package}.${service.name}`,
      new Map(
        service.method.map((method) => [
          method.name,
          { name: method.name, input: method.inputType, output: method.outputType, clientStreaming: method.clientStreaming === true, serverStreaming: method.serverStreaming === true },
        ]),
      ),
    );
  }
  return model;
}

export type ProtoDiff = {
  /** Why `current` is not usable by a client generated from `frozen`. Empty means compatible. */
  breaking: string[];
  /** What `current` adds on top of `frozen`. Never an error. */
  additions: string[];
};

function covered(range: [number, number], by: Array<[number, number]>): boolean {
  return by.some(([start, end]) => start <= range[0] && range[1] <= end);
}

function within(value: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => start <= value && value <= end);
}

function describeField(field: FieldModel): string {
  return `${field.label} ${field.typeName === '' ? field.type : field.typeName} ${field.name} = ${field.number}${field.oneof !== undefined ? ` (oneof ${field.oneof})` : ''}${field.proto3Optional ? ' (proto3 optional)' : ''}`;
}

/** `current` must be `frozen` plus additions. See the header for the rules. */
export function diffProtos(frozen: ProtoModel, current: ProtoModel): ProtoDiff {
  const breaking: string[] = [];
  const additions: string[] = [];

  if (frozen.package !== current.package) {
    breaking.push(`package changed from ${frozen.package} to ${current.package}`);
  }
  if (frozen.syntax !== current.syntax) {
    breaking.push(`syntax changed from ${frozen.syntax} to ${current.syntax}`);
  }

  for (const [name, before] of frozen.messages) {
    const after = current.messages.get(name);
    if (after === undefined) {
      breaking.push(`message ${name} was removed`);
      continue;
    }
    for (const [number, field] of before.fields) {
      const now = after.fields.get(number);
      if (now === undefined) {
        breaking.push(`${name}: field ${number} (${field.name}) was removed or renumbered`);
        continue;
      }
      if (now.name !== field.name) {
        breaking.push(`${name}: field ${number} was renamed from ${field.name} to ${now.name}`);
      }
      if (now.type !== field.type || now.typeName !== field.typeName) {
        breaking.push(`${name}.${field.name}: type changed from ${field.typeName || field.type} to ${now.typeName || now.type}`);
      }
      if (now.label !== field.label) {
        breaking.push(`${name}.${field.name}: cardinality changed from ${field.label} to ${now.label}`);
      }
      if (now.oneof !== field.oneof) {
        breaking.push(`${name}.${field.name}: moved from oneof ${field.oneof ?? '(none)'} to oneof ${now.oneof ?? '(none)'}`);
      }
      if (now.proto3Optional !== field.proto3Optional) {
        breaking.push(`${name}.${field.name}: presence changed (proto3 optional ${field.proto3Optional} -> ${now.proto3Optional})`);
      }
    }
    for (const oneof of before.oneofs) {
      if (!after.oneofs.includes(oneof)) {
        breaking.push(`${name}: oneof ${oneof} was removed`);
      }
    }
    for (const range of before.reservedRanges) {
      if (!covered(range, after.reservedRanges)) {
        breaking.push(`${name}: reserved tags ${range[0]}${range[0] === range[1] ? '' : `-${range[1]}`} are no longer reserved`);
      }
    }
    for (const reserved of before.reservedNames) {
      if (!after.reservedNames.includes(reserved)) {
        breaking.push(`${name}: reserved name ${reserved} is no longer reserved`);
      }
    }
    for (const [number, field] of after.fields) {
      if (before.fields.has(number)) {
        continue;
      }
      if (within(number, before.reservedRanges)) {
        breaking.push(`${name}: field ${field.name} reuses tag ${number}, which the frozen proto reserved`);
      } else if (before.reservedNames.includes(field.name)) {
        breaking.push(`${name}: field ${number} reuses the reserved name ${field.name}`);
      } else {
        additions.push(`${name}: new field ${describeField(field)}`);
      }
    }
  }
  for (const name of current.messages.keys()) {
    if (!frozen.messages.has(name)) {
      additions.push(`new message ${name}`);
    }
  }

  for (const [name, before] of frozen.enums) {
    const after = current.enums.get(name);
    if (after === undefined) {
      breaking.push(`enum ${name} was removed`);
      continue;
    }
    for (const [number, names] of before.values) {
      const now = after.values.get(number);
      if (now === undefined) {
        breaking.push(`${name}: value ${number} (${names.join('/')}) was removed or renumbered`);
      } else if (names.some((each) => !now.includes(each))) {
        breaking.push(`${name}: value ${number} was renamed from ${names.join('/')} to ${now.join('/')}`);
      }
    }
    for (const range of before.reservedRanges) {
      if (!covered(range, after.reservedRanges)) {
        breaking.push(`${name}: reserved values ${range[0]}-${range[1]} are no longer reserved`);
      }
    }
    for (const reserved of before.reservedNames) {
      if (!after.reservedNames.includes(reserved)) {
        breaking.push(`${name}: reserved name ${reserved} is no longer reserved`);
      }
    }
    for (const [number, names] of after.values) {
      if (!before.values.has(number)) {
        if (within(number, before.reservedRanges)) {
          breaking.push(`${name}: value ${names.join('/')} reuses reserved number ${number}`);
        } else {
          additions.push(`${name}: new value ${names.join('/')} = ${number}`);
        }
      }
    }
  }
  for (const name of current.enums.keys()) {
    if (!frozen.enums.has(name)) {
      additions.push(`new enum ${name}`);
    }
  }

  for (const [service, before] of frozen.services) {
    const after = current.services.get(service);
    if (after === undefined) {
      breaking.push(`service ${service} was removed`);
      continue;
    }
    for (const [name, method] of before) {
      const now = after.get(name);
      if (now === undefined) {
        breaking.push(`${service}.${name}: rpc was removed`);
        continue;
      }
      if (now.input !== method.input || now.output !== method.output) {
        breaking.push(`${service}.${name}: signature changed from (${method.input}) -> ${method.output} to (${now.input}) -> ${now.output}`);
      }
      if (now.clientStreaming !== method.clientStreaming || now.serverStreaming !== method.serverStreaming) {
        breaking.push(`${service}.${name}: streaming changed (client ${method.clientStreaming} -> ${now.clientStreaming}, server ${method.serverStreaming} -> ${now.serverStreaming})`);
      }
    }
    for (const name of after.keys()) {
      if (!before.has(name)) {
        additions.push(`${service}: new rpc ${name}`);
      }
    }
  }
  for (const service of current.services.keys()) {
    if (!frozen.services.has(service)) {
      additions.push(`new service ${service}`);
    }
  }

  return { breaking, additions };
}

/**
 * A hash of what a proto MEANS (packages, messages with their tags, types, labels and oneofs, enums,
 * reservations, services), not of its bytes. Comments, formatting and declaration order do not move
 * it, so it survives the scrub the public export applies to every file (it rewrites a few words in
 * comments) while any change to the contract itself does.
 */
export function fingerprint(model: ProtoModel): string {
  const byName = <T extends { name: string }>(a: T, b: T): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const canonical = {
    package: model.package,
    syntax: model.syntax,
    messages: [...model.messages.values()]
      .map((message) => ({
        name: message.fullName,
        fields: [...message.fields.values()].sort((a, b) => a.number - b.number),
        oneofs: [...message.oneofs].sort(),
        reservedRanges: [...message.reservedRanges].sort((a, b) => a[0] - b[0]),
        reservedNames: [...message.reservedNames].sort(),
      }))
      .sort(byName),
    enums: [...model.enums.values()]
      .map((enumeration) => ({
        name: enumeration.fullName,
        values: [...enumeration.values].sort((a, b) => a[0] - b[0]),
        reservedRanges: [...enumeration.reservedRanges].sort((a, b) => a[0] - b[0]),
        reservedNames: [...enumeration.reservedNames].sort(),
      }))
      .sort(byName),
    services: [...model.services]
      .map(([name, methods]) => ({ name, methods: [...methods.values()].sort(byName) }))
      .sort(byName),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

import { readFile } from 'node:fs/promises';
import { basename, relative, resolve, sep } from 'node:path';
import {
  Node,
  Project,
  ScriptTarget,
  SyntaxKind,
  type ArrowFunction,
  type CallExpression,
  type Expression,
  type FunctionExpression,
  type Identifier,
  type ObjectLiteralExpression,
  type SourceFile,
} from 'ts-morph';
import type {
  CapabilityKind,
  InspectReport,
  ToolInventory,
  UnsupportedConstruct,
} from './contracts.js';
import { loadConfig, type LoadedConfig } from './config.js';
import { ExitCode, WitshiftError } from './errors.js';
import { canonicalJson, sha256 } from './hash.js';

type Handler = ArrowFunction | FunctionExpression;

interface SchemaResult {
  readonly schema: Record<string, unknown>;
  readonly optional: boolean;
}

export async function inspectProject(projectPath: string): Promise<InspectReport> {
  const loaded = await loadConfig(projectPath);
  const entryPath = resolveInsideProject(loaded, loaded.config.entry);
  let sourceText: string;
  try {
    sourceText = await readFile(entryPath, 'utf8');
  } catch (error) {
    throw new WitshiftError(
      'ENTRY_NOT_READABLE',
      `Cannot read configured entry ${loaded.config.entry}`,
      ExitCode.ioFailure,
      { entry: loaded.config.entry },
      { cause: error },
    );
  }

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { target: ScriptTarget.ES2024, allowJs: true },
  });
  const sourceFile = project.createSourceFile(entryPath, sourceText, { overwrite: true });
  const unsupported: UnsupportedConstruct[] = [];
  const imports = inspectImports(loaded, sourceFile, unsupported);
  inspectForbiddenSyntax(loaded, sourceFile, unsupported);
  const capabilities = inferCapabilities(imports);
  const tools = inspectRegistrations(loaded, sourceFile, capabilities, unsupported);

  if (tools.length === 0) {
    addUnsupported(
      loaded,
      sourceFile,
      unsupported,
      'NO_STATIC_TOOLS',
      'No static registerTool call found',
    );
  }

  const uniqueUnsupported = dedupeUnsupported(unsupported);
  return {
    schemaVersion: 1,
    command: 'inspect',
    project: basename(loaded.projectRoot),
    entry: loaded.config.entry,
    supported: !uniqueUnsupported.some((item) => item.fatal),
    tools: tools.sort((left, right) => left.name.localeCompare(right.name)),
    imports: [...imports].sort(),
    capabilities: [...capabilities].sort(),
    unsupported: uniqueUnsupported,
    inputDigest: sha256(
      canonicalJson({
        config: JSON.parse(loaded.raw) as unknown,
        files: [{ path: loaded.config.entry, sha256: sha256(sourceText) }],
      }),
    ),
  };
}

function inspectImports(
  loaded: LoadedConfig,
  sourceFile: SourceFile,
  unsupported: UnsupportedConstruct[],
): Set<string> {
  const imports = new Set<string>();
  for (const declaration of sourceFile.getImportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue();
    imports.add(specifier);
    if (specifier === 'child_process' || specifier === 'node:child_process') {
      addUnsupported(
        loaded,
        declaration,
        unsupported,
        'FORBIDDEN_CHILD_PROCESS',
        'Process spawning cannot be migrated',
      );
    }
    if (specifier.endsWith('.node')) {
      addUnsupported(
        loaded,
        declaration,
        unsupported,
        'FORBIDDEN_NATIVE_ADDON',
        'Native Node.js addons cannot be componentized',
      );
    }
  }
  return imports;
}

function inspectForbiddenSyntax(
  loaded: LoadedConfig,
  sourceFile: SourceFile,
  unsupported: UnsupportedConstruct[],
): void {
  for (const node of sourceFile.getDescendants()) {
    if (Node.isCallExpression(node)) {
      const expression = node.getExpression();
      if (expression.getKind() === SyntaxKind.ImportKeyword) {
        addUnsupported(
          loaded,
          node,
          unsupported,
          'FORBIDDEN_DYNAMIC_IMPORT',
          'Dynamic import prevents a closed static dependency graph',
        );
      }
      if (Node.isIdentifier(expression) && expression.getText() === 'eval') {
        addUnsupported(
          loaded,
          node,
          unsupported,
          'FORBIDDEN_DYNAMIC_EVAL',
          'Dynamic evaluation cannot be proven safe',
        );
      }
      if (Node.isIdentifier(expression) && expression.getText() === 'require') {
        addUnsupported(
          loaded,
          node,
          unsupported,
          'FORBIDDEN_REQUIRE',
          'CommonJS runtime resolution is outside the supported ESM subset',
        );
      }
    }
    if (Node.isNewExpression(node) && node.getExpression().getText() === 'Function') {
      addUnsupported(
        loaded,
        node,
        unsupported,
        'FORBIDDEN_DYNAMIC_EVAL',
        'Dynamic Function construction cannot be proven safe',
      );
    }
  }
}

function inspectRegistrations(
  loaded: LoadedConfig,
  sourceFile: SourceFile,
  capabilities: ReadonlySet<CapabilityKind>,
  unsupported: UnsupportedConstruct[],
): ToolInventory[] {
  const tools: ToolInventory[] = [];
  const names = new Set<string>();
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!isRegisterToolCall(call)) continue;
    const parsed = parseRegistration(loaded, call, capabilities, unsupported);
    if (!parsed) continue;
    if (names.has(parsed.name)) {
      addUnsupported(
        loaded,
        call,
        unsupported,
        'AMBIGUOUS_TOOL_NAME',
        `Tool ${parsed.name} is registered more than once`,
      );
      continue;
    }
    names.add(parsed.name);
    tools.push(parsed);
  }
  return tools;
}

function parseRegistration(
  loaded: LoadedConfig,
  call: CallExpression,
  capabilities: ReadonlySet<CapabilityKind>,
  unsupported: UnsupportedConstruct[],
): ToolInventory | undefined {
  const [nameNode, configNode, handlerNode] = call.getArguments();
  if (!nameNode || !Node.isStringLiteral(nameNode)) {
    addUnsupported(
      loaded,
      call,
      unsupported,
      'AMBIGUOUS_TOOL_NAME',
      'Tool name must be a string literal',
    );
    return undefined;
  }
  if (!configNode || !Node.isObjectLiteralExpression(configNode)) {
    addUnsupported(
      loaded,
      call,
      unsupported,
      'AMBIGUOUS_TOOL_CONFIG',
      'Tool config must be an inline object literal',
    );
    return undefined;
  }
  if (
    !handlerNode ||
    (!Node.isArrowFunction(handlerNode) && !Node.isFunctionExpression(handlerNode))
  ) {
    addUnsupported(
      loaded,
      call,
      unsupported,
      'AMBIGUOUS_TOOL_HANDLER',
      'Tool handler must be an inline function in the supported subset',
    );
    return undefined;
  }

  const descriptionNode = propertyInitializer(configNode, 'description');
  if (!descriptionNode || !Node.isStringLiteral(descriptionNode)) {
    addUnsupported(
      loaded,
      configNode,
      unsupported,
      'AMBIGUOUS_DESCRIPTION',
      'Tool description must be a string literal',
    );
    return undefined;
  }
  const inputNode = propertyInitializer(configNode, 'inputSchema');
  if (!inputNode) {
    addUnsupported(
      loaded,
      configNode,
      unsupported,
      'AMBIGUOUS_INPUT_SCHEMA',
      'Tool inputSchema is required and must be statically representable',
    );
    return undefined;
  }
  let inputSchema: Record<string, unknown>;
  let outputSchema: Record<string, unknown> | undefined;
  try {
    inputSchema = parseSchema(inputNode).schema;
    const outputNode = propertyInitializer(configNode, 'outputSchema');
    if (outputNode) outputSchema = parseSchema(outputNode).schema;
  } catch (error) {
    addUnsupported(
      loaded,
      inputNode,
      unsupported,
      'AMBIGUOUS_SCHEMA',
      error instanceof Error ? error.message : 'Schema is not statically representable',
    );
    return undefined;
  }

  const handlerIssue = validateHandler(handlerNode);
  if (handlerIssue) {
    addUnsupported(loaded, handlerNode, unsupported, handlerIssue.code, handlerIssue.message);
    return undefined;
  }

  const relativeFile = relative(loaded.projectRoot, call.getSourceFile().getFilePath())
    .split(sep)
    .join('/');
  const base: ToolInventory = {
    name: nameNode.getLiteralValue(),
    description: descriptionNode.getLiteralValue(),
    inputSchema,
    handlerSource: handlerNode.getText(),
    file: relativeFile,
    line: call.getStartLineNumber(),
    capabilities: [...capabilities].sort(),
  };
  return outputSchema ? { ...base, outputSchema } : base;
}

function isRegisterToolCall(call: CallExpression): boolean {
  const expression = call.getExpression();
  return Node.isPropertyAccessExpression(expression) && expression.getName() === 'registerTool';
}

function propertyInitializer(
  object: ObjectLiteralExpression,
  name: string,
): Expression | undefined {
  const property = object.getProperty(name);
  return property && Node.isPropertyAssignment(property) ? property.getInitializer() : undefined;
}

function parseSchema(expression: Expression): SchemaResult {
  if (Node.isObjectLiteralExpression(expression)) {
    const typeNode = propertyInitializer(expression, 'type');
    if (typeNode && Node.isStringLiteral(typeNode)) {
      const literal = parseLiteral(expression);
      if (!isRecord(literal)) throw new Error('JSON Schema must be an object');
      return { schema: literal, optional: false };
    }
    return parseZodShape(expression);
  }
  if (!Node.isCallExpression(expression))
    throw new Error('Only literal JSON Schema or Zod calls are supported');
  const callee = expression.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) throw new Error('Unsupported schema call');
  const method = callee.getName();
  if (
    method === 'optional' ||
    method === 'nullable' ||
    method === 'default' ||
    method === 'describe'
  ) {
    const base = parseSchema(callee.getExpression());
    if (method === 'nullable')
      return { schema: { anyOf: [base.schema, { type: 'null' }] }, optional: base.optional };
    if (method === 'optional' || method === 'default') return { ...base, optional: true };
    return base;
  }
  const argumentsList = expression.getArguments();
  if (method === 'object') {
    const shape = argumentsList[0];
    if (!shape || !Node.isObjectLiteralExpression(shape))
      throw new Error('z.object requires an inline shape');
    return parseZodShape(shape);
  }
  if (method === 'string') return { schema: { type: 'string' }, optional: false };
  if (method === 'number') return { schema: { type: 'number' }, optional: false };
  if (method === 'int') return { schema: { type: 'integer' }, optional: false };
  if (method === 'boolean') return { schema: { type: 'boolean' }, optional: false };
  if (method === 'unknown') return { schema: {}, optional: false };
  if (method === 'literal') {
    const value = argumentsList[0];
    if (!value) throw new Error('z.literal requires a value');
    return { schema: { const: parseLiteral(value) }, optional: false };
  }
  if (method === 'enum') {
    const values = argumentsList[0];
    if (!values || !Node.isArrayLiteralExpression(values))
      throw new Error('z.enum requires a literal array');
    return { schema: { type: 'string', enum: parseLiteral(values) }, optional: false };
  }
  if (method === 'array') {
    const item = argumentsList[0];
    if (!item) throw new Error('z.array requires an item schema');
    return {
      schema: { type: 'array', items: parseSchema(item as Expression).schema },
      optional: false,
    };
  }
  throw new Error(`Unsupported Zod schema method ${method}`);
}

function parseZodShape(shape: ObjectLiteralExpression): SchemaResult {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const property of shape.getProperties()) {
    if (!Node.isPropertyAssignment(property))
      throw new Error('Schema spreads and shorthand are unsupported');
    const name = property.getName().replace(/^['"]|['"]$/gu, '');
    const initializer = property.getInitializer();
    if (!initializer) throw new Error(`Missing schema for ${name}`);
    const parsed = parseSchema(initializer);
    properties[name] = parsed.schema;
    if (!parsed.optional) required.push(name);
  }
  const schema: Record<string, unknown> = {
    type: 'object',
    properties,
    additionalProperties: false,
  };
  if (required.length > 0) schema['required'] = required;
  return { schema, optional: false };
}

function parseLiteral(node: Node): unknown {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node))
    return node.getLiteralValue();
  if (Node.isNumericLiteral(node)) return Number(node.getText());
  if (node.getKind() === SyntaxKind.TrueKeyword) return true;
  if (node.getKind() === SyntaxKind.FalseKeyword) return false;
  if (node.getKind() === SyntaxKind.NullKeyword) return null;
  if (Node.isArrayLiteralExpression(node)) return node.getElements().map(parseLiteral);
  if (Node.isObjectLiteralExpression(node)) {
    return Object.fromEntries(
      node.getProperties().map((property) => {
        if (!Node.isPropertyAssignment(property))
          throw new Error('Only literal object properties are supported');
        const initializer = property.getInitializer();
        if (!initializer) throw new Error('Literal property has no value');
        return [property.getName().replace(/^['"]|['"]$/gu, ''), parseLiteral(initializer)];
      }),
    );
  }
  throw new Error(`Non-literal value ${node.getText()} is unsupported`);
}

function validateHandler(handler: Handler): { code: string; message: string } | undefined {
  if (handler.isAsync())
    return {
      code: 'UNSUPPORTED_ASYNC_HANDLER',
      message: 'Async handlers are outside the alpha subset',
    };
  if (handler.getParameters().length !== 1) {
    return {
      code: 'AMBIGUOUS_TOOL_HANDLER',
      message: 'Handler must accept exactly one input parameter',
    };
  }
  for (const node of handler.getDescendants()) {
    if (Node.isAwaitExpression(node) || Node.isYieldExpression(node)) {
      return {
        code: 'UNSUPPORTED_ASYNC_HANDLER',
        message: 'Await and yield are outside the alpha subset',
      };
    }
    if (Node.isCallExpression(node) || Node.isNewExpression(node)) {
      return {
        code: 'UNSUPPORTED_HANDLER_CALL',
        message: 'Handler calls and constructors require an explicit future capability adapter',
      };
    }
    if ((Node.isArrowFunction(node) || Node.isFunctionExpression(node)) && node !== handler) {
      return {
        code: 'UNSUPPORTED_NESTED_FUNCTION',
        message: 'Nested functions are outside the alpha subset',
      };
    }
    if (Node.isIdentifier(node) && isExternalIdentifier(node, handler)) {
      return {
        code: 'UNSUPPORTED_EXTERNAL_BINDING',
        message: `Handler references external binding ${node.getText()}`,
      };
    }
  }
  return undefined;
}

function isExternalIdentifier(identifier: Identifier, handler: Handler): boolean {
  const text = identifier.getText();
  if (text === 'undefined') return false;
  const parent = identifier.getParent();
  if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === identifier) return false;
  if (Node.isPropertyAssignment(parent) && parent.getNameNode() === identifier) return false;
  if (Node.isBindingElement(parent) && parent.getPropertyNameNode() === identifier) return false;
  const symbol = identifier.getSymbol();
  if (!symbol) return true;
  return !symbol
    .getDeclarations()
    .some((declaration) => declaration === handler || declaration.getAncestors().includes(handler));
}

function inferCapabilities(imports: ReadonlySet<string>): Set<CapabilityKind> {
  const result = new Set<CapabilityKind>();
  for (const specifier of imports) {
    if (specifier === 'fs' || specifier === 'node:fs' || specifier === 'node:fs/promises') {
      result.add('filesystem-read');
      result.add('filesystem-write');
    }
    if (
      specifier === 'http' ||
      specifier === 'https' ||
      specifier === 'node:http' ||
      specifier === 'node:https' ||
      specifier.includes('fetch') ||
      specifier.includes('axios')
    ) {
      result.add('network');
    }
  }
  return result;
}

function addUnsupported(
  loaded: LoadedConfig,
  node: Node,
  target: UnsupportedConstruct[],
  code: string,
  message: string,
): void {
  target.push({
    code,
    message,
    file: relative(loaded.projectRoot, node.getSourceFile().getFilePath()).split(sep).join('/'),
    line: node.getStartLineNumber(),
    fatal: true,
  });
}

function dedupeUnsupported(items: UnsupportedConstruct[]): UnsupportedConstruct[] {
  return [
    ...new Map(
      items.map((item) => [`${item.code}:${item.file}:${item.line}:${item.message}`, item]),
    ).values(),
  ].sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.code.localeCompare(right.code),
  );
}

function resolveInsideProject(loaded: LoadedConfig, path: string): string {
  const resolved = resolve(loaded.projectRoot, path);
  const prefix = loaded.projectRoot.endsWith(sep)
    ? loaded.projectRoot
    : `${loaded.projectRoot}${sep}`;
  if (resolved !== loaded.projectRoot && !resolved.startsWith(prefix)) {
    throw new WitshiftError(
      'PATH_OUTSIDE_PROJECT',
      `${path} resolves outside the project`,
      ExitCode.invalidConfiguration,
    );
  }
  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

import { readFileSync } from "node:fs";
import YAML from "yaml";
import * as z from "zod/v4";

type RefObject = { $ref: string };
type SecurityRequirement = Record<string, string[]>;

type OpenApiSchemaObject = {
  $ref?: string;
  type?: string;
  description?: string;
  enum?: unknown[];
  nullable?: boolean;
  anyOf?: OpenApiSchema[];
  oneOf?: OpenApiSchema[];
  allOf?: OpenApiSchema[];
  items?: OpenApiSchema;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  additionalProperties?: boolean | OpenApiSchema;
};

type OpenApiSchema = OpenApiSchemaObject | RefObject;

type ParameterObject = {
  $ref?: string;
  name: string;
  in: "path" | "query" | "header" | "cookie";
  description?: string;
  required?: boolean;
  schema?: OpenApiSchema;
};

type MediaTypeObject = { schema?: OpenApiSchema };

type RequestBodyObject = {
  $ref?: string;
  description?: string;
  required?: boolean;
  content?: Record<string, MediaTypeObject>;
};

type OperationObject = {
  operationId?: string;
  summary?: string;
  description?: string;
  deprecated?: boolean;
  parameters?: Array<ParameterObject | RefObject>;
  requestBody?: RequestBodyObject | RefObject;
  security?: SecurityRequirement[];
  tags?: string[];
};

type PathItemObject = {
  parameters?: Array<ParameterObject | RefObject>;
  security?: SecurityRequirement[];
  get?: OperationObject;
  post?: OperationObject;
  put?: OperationObject;
  delete?: OperationObject;
  patch?: OperationObject;
};

type SecuritySchemeObject = {
  flows?: {
    authorizationCode?: {
      scopes?: Record<string, string>;
    };
  };
};

type OpenApiDocument = {
  paths: Record<string, PathItemObject>;
  security?: SecurityRequirement[];
  components?: {
    schemas?: Record<string, OpenApiSchema>;
    parameters?: Record<string, ParameterObject>;
    requestBodies?: Record<string, RequestBodyObject>;
    securitySchemes?: Record<string, SecuritySchemeObject>;
  };
};

export type HttpMethod = "get" | "post" | "put" | "delete" | "patch";

export type ParameterDefinition = {
  argName: string;
  name: string;
  in: "path" | "query";
  description?: string;
  required: boolean;
  schema: z.ZodTypeAny;
};

export type RequestBodyDefinition = {
  description?: string;
  required: boolean;
  contentType: string;
  schema: z.ZodTypeAny;
};

export type OperationDefinition = {
  toolName: string;
  operationId: string;
  method: HttpMethod;
  path: string;
  summary: string;
  description?: string;
  deprecated: boolean;
  tags: string[];
  requiredScopes: string[];
  parameters: ParameterDefinition[];
  requestBody?: RequestBodyDefinition;
  inputSchema?: z.ZodTypeAny;
};

const METHODS: HttpMethod[] = ["get", "post", "put", "delete", "patch"];

const JsonValueSchema: z.ZodTypeAny = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

function isPathOrQueryParameter(
  parameter: ParameterObject,
): parameter is ParameterObject & { in: "path" | "query" } {
  return parameter.in === "path" || parameter.in === "query";
}

export function loadSpotifyOpenApi(schemaPath: string): {
  document: OpenApiDocument;
  operations: OperationDefinition[];
  availableScopes: string[];
} {
  const raw = readFileSync(schemaPath, "utf8");
  const document = YAML.parse(raw) as OpenApiDocument;
  const operations: OperationDefinition[] = [];

  for (const [path, pathItem] of Object.entries(document.paths)) {
    const sharedParameters = (pathItem.parameters ?? []).map((parameter) =>
      resolveParameter(document, parameter),
    );

    for (const method of METHODS) {
      const operation = pathItem[method];

      if (!operation) {
        continue;
      }

      const operationParameters = [
        ...sharedParameters,
        ...(operation.parameters ?? []).map((parameter) =>
          resolveParameter(document, parameter),
        ),
      ].filter(isPathOrQueryParameter);

      const usedNames = new Set<string>();
      const parameters = operationParameters.map((parameter) => {
        const argName = uniqueArgumentName(
          sanitizeArgumentName(parameter.name),
          parameter.in,
          usedNames,
        );

        usedNames.add(argName);

        let schema = parameter.schema
          ? openApiSchemaToZod(document, parameter.schema)
          : JsonValueSchema;

        if (!parameter.required) {
          schema = schema.optional();
        }

        return {
          argName,
          name: parameter.name,
          in: parameter.in,
          description: parameter.description,
          required: Boolean(parameter.required),
          schema,
        } satisfies ParameterDefinition;
      });

      const requestBody = operation.requestBody
        ? resolveRequestBody(document, operation.requestBody)
        : undefined;

      const shape: Record<string, z.ZodTypeAny> = {};

      for (const parameter of parameters) {
        shape[parameter.argName] = parameter.schema;
      }

      if (requestBody) {
        let bodySchema = requestBody.schema;

        if (!requestBody.required) {
          bodySchema = bodySchema.optional();
        }

        shape.body = bodySchema.describe(
          requestBody.description
            ? `${requestBody.description} (${requestBody.contentType})`
            : `Request body (${requestBody.contentType})`,
        );
      }

      operations.push({
        toolName: `spotify.${operation.operationId ?? deriveOperationId(method, path)}`,
        operationId: operation.operationId ?? deriveOperationId(method, path),
        method,
        path,
        summary:
          collapseWhitespace(operation.summary ?? deriveSummary(method, path)) ??
          deriveSummary(method, path),
        description: collapseWhitespace(operation.description),
        deprecated: Boolean(operation.deprecated),
        tags: operation.tags ?? [],
        requiredScopes: extractScopes(
          operation.security ?? pathItem.security ?? document.security ?? [],
        ),
        parameters,
        requestBody,
        inputSchema: Object.keys(shape).length > 0 ? z.object(shape) : undefined,
      });
    }
  }

  return {
    document,
    operations,
    availableScopes: extractAvailableScopes(document),
  };
}

function resolveParameter(
  document: OpenApiDocument,
  parameter: ParameterObject | RefObject,
): ParameterObject {
  const resolved = resolveValue(document, parameter) as ParameterObject;

  if (!resolved.schema) {
    return resolved;
  }

  return {
    ...resolved,
    schema: resolveSchema(document, resolved.schema),
  };
}

function resolveRequestBody(
  document: OpenApiDocument,
  requestBody: RequestBodyObject | RefObject,
): RequestBodyDefinition {
  const resolved = resolveValue(document, requestBody) as RequestBodyObject;
  const entries = Object.entries(resolved.content ?? {});
  const chosenEntry =
    entries.find(([contentType]) => contentType.includes("json")) ?? entries[0];

  if (!chosenEntry) {
    return {
      description: resolved.description,
      required: Boolean(resolved.required),
      contentType: "application/json",
      schema: JsonValueSchema,
    };
  }

  const [contentType, mediaType] = chosenEntry;

  return {
    description: resolved.description,
    required: Boolean(resolved.required),
    contentType,
    schema: mediaType.schema
      ? openApiSchemaToZod(document, mediaType.schema)
      : JsonValueSchema,
  };
}

function extractAvailableScopes(document: OpenApiDocument): string[] {
  const scopes =
    document.components?.securitySchemes?.oauth_2_0?.flows?.authorizationCode?.scopes ?? {};

  return Object.keys(scopes).sort();
}

function extractScopes(securityRequirements: SecurityRequirement[]): string[] {
  const scopes = new Set<string>();

  for (const requirement of securityRequirements) {
    for (const values of Object.values(requirement)) {
      for (const scope of values) {
        scopes.add(scope);
      }
    }
  }

  return [...scopes].sort();
}

function sanitizeArgumentName(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(sanitized) ? sanitized : `arg_${sanitized}`;
}

function uniqueArgumentName(
  baseName: string,
  location: "path" | "query",
  usedNames: Set<string>,
): string {
  if (!usedNames.has(baseName)) {
    return baseName;
  }

  const alternate = `${location}_${baseName}`;

  if (!usedNames.has(alternate)) {
    return alternate;
  }

  let counter = 2;
  while (usedNames.has(`${alternate}_${counter}`)) {
    counter += 1;
  }

  return `${alternate}_${counter}`;
}

function deriveOperationId(method: HttpMethod, path: string): string {
  return `${method}-${path.replace(/[{}]/g, "").replace(/[^\w]+/g, "-")}`.replace(
    /-+/g,
    "-",
  );
}

function deriveSummary(method: HttpMethod, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

function collapseWhitespace(value?: string): string | undefined {
  return value?.replace(/\s+/g, " ").trim();
}

function resolveSchema(document: OpenApiDocument, schema: OpenApiSchema): OpenApiSchemaObject {
  return resolveValue(document, schema) as OpenApiSchemaObject;
}

function resolveValue(document: OpenApiDocument, value: unknown): unknown {
  if (!isRefObject(value)) {
    return value;
  }

  return resolveRef(document, value.$ref);
}

function resolveRef(document: OpenApiDocument, ref: string): unknown {
  if (!ref.startsWith("#/")) {
    throw new Error(`Unsupported external $ref: ${ref}`);
  }

  const parts = ref
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));

  let current: unknown = document;

  for (const part of parts) {
    if (typeof current !== "object" || current === null || !(part in current)) {
      throw new Error(`Unable to resolve $ref: ${ref}`);
    }

    current = (current as Record<string, unknown>)[part];
  }

  return isRefObject(current) ? resolveRef(document, current.$ref) : current;
}

function isRefObject(value: unknown): value is RefObject {
  return typeof value === "object" && value !== null && "$ref" in value;
}

function openApiSchemaToZod(
  document: OpenApiDocument,
  schema: OpenApiSchema,
  visitedRefs = new Set<string>(),
): z.ZodTypeAny {
  if (isRefObject(schema)) {
    if (visitedRefs.has(schema.$ref)) {
      return JsonValueSchema;
    }

    const nextVisitedRefs = new Set(visitedRefs);
    nextVisitedRefs.add(schema.$ref);

    return openApiSchemaToZod(
      document,
      resolveRef(document, schema.$ref) as OpenApiSchema,
      nextVisitedRefs,
    );
  }

  let result: z.ZodTypeAny;

  if (schema.enum && schema.enum.length > 0) {
    const values = schema.enum
      .filter((value): value is string => typeof value === "string")
      .map((value) => value);

    result = values.length > 0 ? z.enum(values as [string, ...string[]]) : JsonValueSchema;
  } else if (schema.oneOf && schema.oneOf.length >= 2) {
    result = z.union(
      schema.oneOf.map((entry) => openApiSchemaToZod(document, entry, visitedRefs)) as [
        z.ZodTypeAny,
        z.ZodTypeAny,
        ...z.ZodTypeAny[],
      ],
    );
  } else if (schema.anyOf && schema.anyOf.length >= 2) {
    result = z.union(
      schema.anyOf.map((entry) => openApiSchemaToZod(document, entry, visitedRefs)) as [
        z.ZodTypeAny,
        z.ZodTypeAny,
        ...z.ZodTypeAny[],
      ],
    );
  } else if (schema.allOf && schema.allOf.length > 0) {
    result = JsonValueSchema;
  } else if (schema.type === "string") {
    result = z.string();
  } else if (schema.type === "integer") {
    result = z.number().int();
  } else if (schema.type === "number") {
    result = z.number();
  } else if (schema.type === "boolean") {
    result = z.boolean();
  } else if (schema.type === "array") {
    result = z.array(
      schema.items ? openApiSchemaToZod(document, schema.items, visitedRefs) : JsonValueSchema,
    );
  } else if (schema.type === "object" || schema.properties || schema.additionalProperties) {
    const shape: Record<string, z.ZodTypeAny> = {};
    const required = new Set(schema.required ?? []);

    for (const [propertyName, propertySchema] of Object.entries(schema.properties ?? {})) {
      let propertyZod = openApiSchemaToZod(document, propertySchema, visitedRefs);

      if (!required.has(propertyName)) {
        propertyZod = propertyZod.optional();
      }

      shape[propertyName] = propertyZod;
    }

    const objectSchema = z.object(shape);

    if (schema.additionalProperties) {
      result =
        schema.additionalProperties === true
          ? objectSchema.catchall(JsonValueSchema)
          : objectSchema.catchall(
              openApiSchemaToZod(document, schema.additionalProperties, visitedRefs),
            );
    } else {
      result = objectSchema;
    }
  } else {
    result = JsonValueSchema;
  }

  if (schema.nullable) {
    result = result.nullable();
  }

  const description = collapseWhitespace(schema.description);

  if (description) {
    result = result.describe(description);
  }

  return result;
}

import allLodash from 'lodash';

import {
  TokenGroup,
  TokenTree,
  TokenType,
  TokenUnit,
  TokenValue,
} from './types/designTokenFormatModule.js';
import { ConcreteTokenTree } from './types/concreteTree.js';
import { matchIsAlias } from './utils/matchIsAlias.js';
import { validateTokenValue } from './utils/validateTokenValue.js';
import { validateTokenAndGroupName } from './utils/validateTokenAndGroupName.js';
import { inferJSONValueType } from './utils/inferJSONValueType.js';

const { get, omitBy } = allLodash;

export function resolveAlias(rawAlias: string, context?: TokenTree) {
  // rawAlias is like {colors.primary}
  const alias = rawAlias.slice(1, -1);
  const currentPath = alias.split('.');
  const foundEntry = get(context, alias) as TokenTree;
  if (foundEntry) {
    const tokenName = alias.split('.').pop();
    const parentPath = alias.split('.').slice(0, -1).join('.');
    const maybeParent =
      parentPath.length > 0
        ? (get(context, parentPath) as TokenTree)
        : undefined;

    const result = parseDesignTokens(
      tokenName ? { [tokenName]: foundEntry } : {},
      maybeParent,
      context,
      currentPath
    ) as TokenTree;
    const formatted = Object.values(result)[0];

    return {
      ...formatted,
      _kind: 'alias' as const,
      _name: tokenName ?? null,
      _path: currentPath,
    };
  } else {
    throw new Error(
      `Alias "${alias}" not found in context: ${JSON.stringify(context)}`
    );
  }
}

function resolveObjectValue(
  value: Omit<TokenValue, string | symbol | number>,
  parent?: TokenTree,
  context?: TokenTree,
  path: Array<string> = []
): { [key: string]: TokenValue } {
  return Object.entries(value).reduce((acc, [key, value]) => {
    const currentPath = path.concat(key);
    if (matchIsAlias(value)) {
      return {
        ...acc,
        [key]: resolveAlias(value as string, context),
      };
    } else if (Array.isArray(value)) {
      return {
        ...acc,
        [key]: resolveArrayValue(value, parent, context, currentPath),
      };
    } else if (value !== null && typeof value === 'object') {
      return {
        ...acc,
        [key]: resolveObjectValue(value, parent, context, currentPath),
      };
    } else {
      return {
        ...acc,
        [key]: value,
      };
    }
  }, {});
}

function resolveArrayValue(
  value: TokenValue[],
  parent?: TokenTree,
  context?: TokenTree,
  path: Array<string> = []
): TokenValue[] {
  return value.map((item, i) => {
    const currentPath = path.concat(`[${i}]`);
    if (matchIsAlias(item)) {
      return resolveAlias(item as string, context);
    } else if (Array.isArray(item)) {
      return resolveArrayValue(item, parent, context, currentPath);
    } else if (item !== null && typeof item === 'object') {
      return resolveObjectValue(item, parent, context, currentPath);
    }

    return item;
  });
}

export function parseDesignTokens(
  tokens: TokenTree,
  parent?: TokenTree,
  context?: TokenTree,
  path: Array<string> = []
): ConcreteTokenTree {
  if (!context) {
    context = tokens;
  }

  return Object.entries(tokens).reduce((acc, [name, value]) => {
    // const { $type, $description, $value, $extensions, ...rest } = value
    validateTokenAndGroupName(name);
    const currentPath = path.concat(name);

    let maybeType: TokenType | undefined;
    if (value.$type) {
      maybeType = value.$type as TokenType;
    } else if (parent && parent.$type) {
      // From direct parent if exists
      maybeType = parent.$type as TokenType;
    }

    // A Token has a $value
    if ('$value' in value && value.$value !== undefined) {
      const { $description, $value, $extensions } = value as TokenUnit;
      const isAlias = matchIsAlias($value);

      let finalValue: TokenValue = $value;
      if (isAlias) {
        finalValue = resolveAlias($value as string, context);
      } else if (Array.isArray($value)) {
        finalValue = resolveArrayValue($value, parent, context, currentPath);
      } else if ($value !== null && typeof $value === 'object') {
        finalValue = resolveObjectValue($value, parent, context, currentPath);
      }

      if (
        isAlias &&
        finalValue !== null &&
        typeof finalValue === 'object' &&
        '$type' in finalValue
      ) {
        if (maybeType === undefined) {
          maybeType = finalValue.$type as TokenType;
        } else if (maybeType !== finalValue.$type) {
          throw new Error(
            `Type mismatch: ${maybeType} !== ${
              finalValue.$type
            } at path "${currentPath.join('.')}"`
          );
        }
      }

      // We expect the process to have resolved the token $type at this stage
      if (maybeType === undefined) {
        maybeType = inferJSONValueType($value);
      }
      validateTokenValue(maybeType, $value);

      return {
        ...acc,
        [name]: {
          $type: maybeType,
          $value: finalValue,
          ...($description ? { $description } : {}),
          ...($extensions ? { $extensions } : {}),
          _kind: 'token' as const,
          _path: currentPath,
        },
      };
    } else {
      // A Group has NOT a $value
      const { $description } = value as TokenGroup;
      const restOfKeys = omitBy(value, (v, k) => k.startsWith('$'));

      const merged = Object.entries(restOfKeys)
        .filter(
          ([_, v]) => v !== null && typeof v === 'object' && !Array.isArray(v)
        )
        .reduce(
          (acc, [k, v]) => ({
            ...acc,
            ...parseDesignTokens(
              { [k]: v } as TokenTree,
              value as TokenTree,
              context,
              currentPath
            ),
          }),
          {}
        ) as TokenTree;
      return {
        ...acc,
        [name]: {
          ...(maybeType ? { $type: maybeType } : {}),
          ...($description ? { $description } : {}),
          _kind: 'group' as const,
          _path: currentPath,
          ...merged,
        },
      };
    }
  }, {});
}
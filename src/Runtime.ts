import {
  findFirst,
  findLast,
  lower,
  padLeft,
  padRight,
  replace,
  split,
  trim,
  trimLeft,
  trimRight,
  upper,
} from './utils/strings';
import { Text } from './utils/text';

import type { ExpressionNode } from './AST.type';
import type {
  JSONArray,
  JSONArrayArray,
  JSONArrayKeyValuePairs,
  JSONArrayObject,
  JSONObject,
  JSONValue,
  ObjectDict,
} from './JSON.type';
import type { TreeInterpreter } from './TreeInterpreter';

export enum InputArgument {
  TYPE_NUMBER = 0,
  TYPE_ANY = 1,
  TYPE_STRING = 2,
  TYPE_ARRAY = 3,
  TYPE_OBJECT = 4,
  TYPE_BOOLEAN = 5,
  TYPE_EXPREF = 6,
  TYPE_NULL = 7,
  TYPE_ARRAY_NUMBER = 8,
  TYPE_ARRAY_STRING = 9,
  TYPE_ARRAY_OBJECT = 10,
  TYPE_ARRAY_ARRAY = 11,
}

export interface InputSignature {
  types: InputArgument[];
  variadic?: boolean;
  optional?: boolean;
}

export type RuntimeFunction<T extends (JSONValue | ExpressionNode)[], U> = (resolvedArgs: T) => U;

export interface FunctionSignature {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // biome-ignore lint: lint/suspicious/noExplicitAny
  _func: RuntimeFunction<any, JSONValue>;
  _signature: InputSignature[];
}

export interface FunctionTable {
  [functionName: string]: FunctionSignature;
}

export class Runtime {
  _interpreter: TreeInterpreter;
  _functionTable: FunctionTable;
  TYPE_NAME_TABLE: { [InputArgument: number]: string } = {
    [InputArgument.TYPE_NUMBER]: 'number',
    [InputArgument.TYPE_ANY]: 'any',
    [InputArgument.TYPE_STRING]: 'string',
    [InputArgument.TYPE_ARRAY]: 'array',
    [InputArgument.TYPE_OBJECT]: 'object',
    [InputArgument.TYPE_BOOLEAN]: 'boolean',
    [InputArgument.TYPE_EXPREF]: 'expression',
    [InputArgument.TYPE_NULL]: 'null',
    [InputArgument.TYPE_ARRAY_NUMBER]: 'Array<number>',
    [InputArgument.TYPE_ARRAY_OBJECT]: 'Array<object>',
    [InputArgument.TYPE_ARRAY_STRING]: 'Array<string>',
    [InputArgument.TYPE_ARRAY_ARRAY]: 'Array<Array<any>>',
  };

  constructor(interpreter: TreeInterpreter) {
    this._interpreter = interpreter;
    this._functionTable = this.functionTable;
  }

  registerFunction(
    name: string,
    customFunction: RuntimeFunction<(JSONValue | ExpressionNode)[], JSONValue>,
    signature: InputSignature[],
  ): void {
    if (name in this._functionTable) {
      throw new Error(`Function already defined: ${name}()`);
    }
    this._functionTable[name] = {
      _func: customFunction.bind(this),
      _signature: signature,
    };
  }

  callFunction(name: string, resolvedArgs: (JSONValue | ExpressionNode)[]): JSONValue {
    const functionEntry = this._functionTable[name];
    if (functionEntry === undefined) {
      throw new Error(`Unknown function: ${name}()`);
    }
    this.validateArgs(name, resolvedArgs, functionEntry._signature);
    return functionEntry._func.call(this, resolvedArgs);
  }

  private validateInputSignatures(name: string, signature: InputSignature[]): void {
    for (let i = 0; i < signature.length; i += 1) {
      if ('variadic' in signature[i] && i !== signature.length - 1) {
        throw new Error(`Invalid arity: ${name}() 'variadic' argument ${i + 1} must occur last`);
      }
    }
  }

  private validateArgs(name: string, args: (JSONValue | ExpressionNode)[], signature: InputSignature[]): void {
    let pluralized: boolean;
    this.validateInputSignatures(name, signature);
    const numberOfRequiredArgs = signature.filter(argSignature => !(argSignature.optional ?? false)).length;
    const lastArgIsVariadic = signature[signature.length - 1]?.variadic ?? false;
    const tooFewArgs = args.length < numberOfRequiredArgs;
    const tooManyArgs = args.length > signature.length;
    const tooFewModifier =
      tooFewArgs && ((!lastArgIsVariadic && numberOfRequiredArgs > 1) || lastArgIsVariadic) ? 'at least ' : '';

    if ((lastArgIsVariadic && tooFewArgs) || (!lastArgIsVariadic && (tooFewArgs || tooManyArgs))) {
      pluralized = signature.length > 1;
      throw new Error(
        `Invalid arity: ${name}() takes ${tooFewModifier}${numberOfRequiredArgs} argument${
          (pluralized && 's') || ''
        } but received ${args.length}`,
      );
    }

    let currentSpec: InputArgument[];
    let actualType: InputArgument;
    let typeMatched: boolean;
    for (let i = 0; i < signature.length; i += 1) {
      typeMatched = false;
      currentSpec = signature[i].types;
      actualType = this.getTypeName(args[i]) as InputArgument;
      let j: number;
      for (j = 0; j < currentSpec.length; j += 1) {
        if (actualType !== undefined && this.typeMatches(actualType, currentSpec[j], args[i])) {
          typeMatched = true;
          break;
        }
      }
      if (!typeMatched && actualType !== undefined) {
        const expected = currentSpec
          .map((typeIdentifier): string => {
            return this.TYPE_NAME_TABLE[typeIdentifier];
          })
          .join(' | ');

        throw new Error(
          `Invalid type: ${name}() expected argument ${i + 1} to be type (${expected}) but received type ${
            this.TYPE_NAME_TABLE[actualType]
          } instead.`,
        );
      }
    }
  }

  private typeMatches(actual: InputArgument, expected: InputArgument, argValue: unknown): boolean {
    if (expected === InputArgument.TYPE_ANY) {
      return true;
    }
    if (
      expected === InputArgument.TYPE_ARRAY_STRING ||
      expected === InputArgument.TYPE_ARRAY_NUMBER ||
      expected === InputArgument.TYPE_ARRAY_OBJECT ||
      expected === InputArgument.TYPE_ARRAY_ARRAY ||
      expected === InputArgument.TYPE_ARRAY
    ) {
      if (expected === InputArgument.TYPE_ARRAY) {
        return actual === InputArgument.TYPE_ARRAY;
      }
      if (actual === InputArgument.TYPE_ARRAY) {
        let subtype;
        if (expected === InputArgument.TYPE_ARRAY_NUMBER) {
          subtype = InputArgument.TYPE_NUMBER;
        } else if (expected === InputArgument.TYPE_ARRAY_OBJECT) {
          subtype = InputArgument.TYPE_OBJECT;
        } else if (expected === InputArgument.TYPE_ARRAY_STRING) {
          subtype = InputArgument.TYPE_STRING;
        } else if (expected === InputArgument.TYPE_ARRAY_ARRAY) {
          subtype = InputArgument.TYPE_ARRAY;
        }
        const array = <JSONValue[]>argValue;
        for (let i = 0; i < array.length; i += 1) {
          const typeName = this.getTypeName(array[i]);
          if (typeName !== undefined && subtype !== undefined && !this.typeMatches(typeName, subtype, array[i])) {
            return false;
          }
        }
        return true;
      }
    } else {
      return actual === expected;
    }
    return false;
  }
  private getTypeName(obj: JSONValue | ExpressionNode): InputArgument | undefined {
    switch (Object.prototype.toString.call(obj)) {
      case '[object String]':
        return InputArgument.TYPE_STRING;
      case '[object Number]':
        return InputArgument.TYPE_NUMBER;
      case '[object Array]':
        return InputArgument.TYPE_ARRAY;
      case '[object Boolean]':
        return InputArgument.TYPE_BOOLEAN;
      case '[object Null]':
        return InputArgument.TYPE_NULL;
      case '[object Object]':
        if ((obj as ObjectDict).expref) {
          return InputArgument.TYPE_EXPREF;
        }
        return InputArgument.TYPE_OBJECT;

      default:
        return;
    }
  }

  createKeyFunction(exprefNode: ExpressionNode, allowedTypes: InputArgument[]): (x: JSONValue) => JSONValue {
    const interpreter = this._interpreter;
    const keyFunc = (x: JSONValue): JSONValue => {
      const current = interpreter.visit(exprefNode, x) as JSONValue;
      if (!allowedTypes.includes(this.getTypeName(current) as InputArgument)) {
        const msg = `Invalid type: expected one of (${allowedTypes
          .map(t => this.TYPE_NAME_TABLE[t])
          .join(' | ')}), received ${this.TYPE_NAME_TABLE[this.getTypeName(current) as InputArgument]}`;
        throw new Error(msg);
      }
      return current;
    };
    return keyFunc;
  }

  private functionAbs: RuntimeFunction<number[], number> = ([inputValue]) => {
    return Math.abs(inputValue);
  };

  private functionAvg: RuntimeFunction<[number[]], number | null> = ([inputArray]) => {
    if (!inputArray || inputArray.length == 0) {
      return null;
    }

    let sum = 0;
    for (let i = 0; i < inputArray.length; i += 1) {
      sum += inputArray[i];
    }
    return sum / inputArray.length;
  };

  private functionCeil: RuntimeFunction<[number], number> = ([inputValue]) => {
    return Math.ceil(inputValue);
  };

  private functionContains: RuntimeFunction<[string[] | JSONArray, JSONValue], JSONValue> = ([
    searchable,
    searchValue,
  ]) => {
    if (Array.isArray(searchable)) {
      const array = <JSONArray>searchable;
      return array.includes(searchValue);
    }

    if (typeof searchable === 'string') {
      const text = <string>searchable;
      if (typeof searchValue === 'string') {
        return text.includes(searchValue);
      }
    }

    return null;
  };

  private functionEndsWith: RuntimeFunction<[string, string], boolean> = resolvedArgs => {
    const [searchStr, suffix] = resolvedArgs;
    return searchStr.includes(suffix, searchStr.length - suffix.length);
  };

  private functionFindFirst: RuntimeFunction<JSONValue[], number | null> = resolvedArgs => {
    const subject = <string>resolvedArgs[0];
    const search = <string>resolvedArgs[1];
    const start = (resolvedArgs.length > 2 && <number>resolvedArgs[2]) || undefined;
    const end = (resolvedArgs.length > 3 && <number>resolvedArgs[3]) || undefined;
    return findFirst(subject, search, start, end);
  };

  private functionFindLast: RuntimeFunction<JSONValue[], number | null> = resolvedArgs => {
    const subject = <string>resolvedArgs[0];
    const search = <string>resolvedArgs[1];
    const start = (resolvedArgs.length > 2 && <number>resolvedArgs[2]) || undefined;
    const end = (resolvedArgs.length > 3 && <number>resolvedArgs[3]) || undefined;
    return findLast(subject, search, start, end);
  };

  private functionFloor: RuntimeFunction<[number], number> = ([inputValue]) => {
    return Math.floor(inputValue);
  };

  private functionFromItems: RuntimeFunction<[JSONArrayKeyValuePairs], JSONObject> = ([array]) => {
    array.map((pair: [string, JSONValue]) => {
      if (pair.length != 2 || typeof pair[0] !== 'string') {
        throw new Error('invalid value, each array must contain two elements, a pair of string and value');
      }
    });
    return Object.fromEntries(array);
  };

  private functionGroupBy: RuntimeFunction<[JSONArrayObject, ExpressionNode], JSONValue> = ([array, exprefNode]) => {
    const keyFunction = this.createKeyFunction(exprefNode, [InputArgument.TYPE_STRING]);
    return array.reduce((acc, cur) => {
      const k = keyFunction(cur ?? {});
      const target = <JSONArray>(acc[<string>k] = acc[<string>k] || []);
      target.push(cur);
      return acc;
    }, {});
  };

  private functionItems: RuntimeFunction<[JSONObject], JSONArray> = ([inputValue]) => {
    return Object.entries(inputValue);
  };

  private functionJoin: RuntimeFunction<[string, string[]], string> = resolvedArgs => {
    const [joinChar, listJoin] = resolvedArgs;
    return listJoin.join(joinChar);
  };

  private functionKeys: RuntimeFunction<[JSONObject], string[]> = ([inputObject]) => {
    return Object.keys(inputObject);
  };

  private functionLength: RuntimeFunction<[string | JSONArray | JSONObject], number> = ([inputValue]) => {
    if (typeof inputValue === 'string') {
      return new Text(inputValue).length;
    }
    if (Array.isArray(inputValue)) {
      return inputValue.length;
    }
    return Object.keys(inputValue).length;
  };

  private functionLower: RuntimeFunction<[string], string> = ([subject]) => {
    return lower(subject);
  };

  private functionMap: RuntimeFunction<[ExpressionNode, JSONArray], JSONArray> = ([exprefNode, elements]) => {
    if (!this._interpreter) {
      return [];
    }
    const mapped = [];
    const interpreter = this._interpreter;
    for (let i = 0; i < elements.length; i += 1) {
      mapped.push(<JSONValue>interpreter.visit(exprefNode, elements[i]));
    }
    return mapped;
  };

  private functionMax: RuntimeFunction<[(string | number)[]], string | number | null> = ([inputValue]) => {
    if (!inputValue.length) {
      return null;
    }

    const typeName = this.getTypeName(inputValue[0]);
    if (typeName === InputArgument.TYPE_NUMBER) {
      return Math.max(...(inputValue as number[]));
    }

    const elements = inputValue as string[];
    let maxElement = elements[0];
    for (let i = 1; i < elements.length; i += 1) {
      if (maxElement.localeCompare(elements[i]) < 0) {
        maxElement = elements[i];
      }
    }
    return maxElement;
  };

  private functionMaxBy: RuntimeFunction<[number[] | string[], ExpressionNode], JSONValue> = resolvedArgs => {
    const exprefNode = resolvedArgs[1];
    const resolvedArray = resolvedArgs[0];
    const keyFunction = this.createKeyFunction(exprefNode, [InputArgument.TYPE_NUMBER, InputArgument.TYPE_STRING]);
    let maxNumber = -Infinity;
    let maxRecord!: JSONValue;
    let current: number | undefined;
    for (let i = 0; i < resolvedArray.length; i += 1) {
      current = keyFunction && (keyFunction(resolvedArray[i]) as number);
      if (current !== undefined && current > maxNumber) {
        maxNumber = current;
        maxRecord = resolvedArray[i];
      }
    }
    return maxRecord || null;
  };

  private functionMerge: RuntimeFunction<JSONObject[], JSONObject> = resolvedArgs => {
    let merged = {};
    for (let i = 0; i < resolvedArgs.length; i += 1) {
      const current = resolvedArgs[i];
      merged = Object.assign(merged, current);
    }
    return merged;
  };

  private functionMin: RuntimeFunction<[(string | number)[]], string | number | null> = ([inputValue]) => {
    if (!inputValue.length) {
      return null;
    }

    const typeName = this.getTypeName(inputValue[0]);
    if (typeName === InputArgument.TYPE_NUMBER) {
      return Math.min(...(inputValue as number[]));
    }

    const elements = inputValue as string[];
    let minElement = elements[0];
    for (let i = 1; i < elements.length; i += 1) {
      if (elements[i].localeCompare(minElement) < 0) {
        minElement = elements[i];
      }
    }
    return minElement;
  };

  private functionMinBy: RuntimeFunction<[number[] | string[], ExpressionNode], JSONValue> = resolvedArgs => {
    const exprefNode = resolvedArgs[1];
    const resolvedArray = resolvedArgs[0];
    const keyFunction = this.createKeyFunction(exprefNode, [InputArgument.TYPE_NUMBER, InputArgument.TYPE_STRING]);
    let minNumber = Infinity;
    let minRecord!: JSONValue;
    let current: number | undefined;
    for (let i = 0; i < resolvedArray.length; i += 1) {
      current = keyFunction && (keyFunction(resolvedArray[i]) as number);
      if (current !== undefined && current < minNumber) {
        minNumber = current;
        minRecord = resolvedArray[i];
      }
    }
    return minRecord || null;
  };

  private functionNotNull: RuntimeFunction<JSONArray, JSONValue> = resolvedArgs => {
    for (let i = 0; i < resolvedArgs.length; i += 1) {
      if (this.getTypeName(resolvedArgs[i]) !== InputArgument.TYPE_NULL) {
        return resolvedArgs[i];
      }
    }
    return null;
  };

  private functionPadLeft: RuntimeFunction<JSONValue[], string> = resolvedArgs => {
    const subject = <string>resolvedArgs[0];
    const width = <number>resolvedArgs[1];
    const padding = (resolvedArgs.length > 2 && <string>resolvedArgs[2]) || undefined;
    return padLeft(subject, width, padding);
  };

  private functionPadRight: RuntimeFunction<JSONValue[], string> = resolvedArgs => {
    const subject = <string>resolvedArgs[0];
    const width = <number>resolvedArgs[1];
    const padding = (resolvedArgs.length > 2 && <string>resolvedArgs[2]) || undefined;
    return padRight(subject, width, padding);
  };

  private functionReplace: RuntimeFunction<JSONValue[], string> = resolvedArgs => {
    const subject = <string>resolvedArgs[0];
    const string = <string>resolvedArgs[1];
    const by = <string>resolvedArgs[2];
    return replace(subject, string, by, resolvedArgs.length > 3 ? <number>resolvedArgs[3] : undefined);
  };

  private functionSplit: RuntimeFunction<JSONValue[], string[]> = resolvedArgs => {
    const subject = <string>resolvedArgs[0];
    const search = <string>resolvedArgs[1];
    return split(subject, search, resolvedArgs.length > 2 ? <number>resolvedArgs[2] : undefined);
  };

  private functionReverse: RuntimeFunction<[string | JSONArray], string | JSONArray> = ([inputValue]) => {
    const typeName = this.getTypeName(inputValue);
    if (typeName === InputArgument.TYPE_STRING) {
      return new Text(inputValue as string).reverse();
    }
    const reversedArray = (inputValue as JSONArray).slice(0);
    reversedArray.reverse();
    return reversedArray;
  };

  private functionSort: RuntimeFunction<[(string | number)[]], (string | number)[]> = ([inputValue]) => {
    if (inputValue.length == 0) {
      return inputValue;
    }
    if (typeof inputValue[0] === 'string') {
      return (<string[]>[...inputValue]).sort(Text.comparer);
    }
    return [...inputValue].sort();
  };

  private functionSortBy: RuntimeFunction<[number[] | string[], ExpressionNode], JSONValue> = resolvedArgs => {
    const sortedArray = resolvedArgs[0].slice(0);
    if (sortedArray.length === 0) {
      return sortedArray;
    }
    const interpreter = this._interpreter;
    const exprefNode = resolvedArgs[1];
    const requiredType = this.getTypeName(interpreter.visit(exprefNode, sortedArray[0]) as JSONValue);
    if (requiredType !== undefined && ![InputArgument.TYPE_NUMBER, InputArgument.TYPE_STRING].includes(requiredType)) {
      throw new Error(`Invalid type: unexpected type (${this.TYPE_NAME_TABLE[requiredType]})`);
    }
    function throwInvalidTypeError(rt: Runtime, item: string | number): never {
      throw new Error(
        `Invalid type: expected (${rt.TYPE_NAME_TABLE[requiredType as InputArgument]}), received ${
          rt.TYPE_NAME_TABLE[rt.getTypeName(item) as InputArgument]
        }`,
      );
    }

    return sortedArray.sort((a, b) => {
      const exprA = interpreter.visit(exprefNode, a) as number | string;
      const exprB = interpreter.visit(exprefNode, b) as number | string;
      if (this.getTypeName(exprA) !== requiredType) {
        throwInvalidTypeError(this, exprA);
      } else if (this.getTypeName(exprB) !== requiredType) {
        throwInvalidTypeError(this, exprB);
      }
      if (requiredType === InputArgument.TYPE_STRING) {
        return Text.comparer(<string>exprA, <string>exprB);
      }
      return <number>exprA - <number>exprB;
    });
  };

  private functionStartsWith: RuntimeFunction<[string, string], boolean> = ([searchable, searchStr]) => {
    return searchable.startsWith(searchStr);
  };

  private functionSum: RuntimeFunction<[number[]], number> = ([inputValue]) => {
    return inputValue.reduce((x, y) => x + y, 0);
  };

  private functionToArray: RuntimeFunction<[JSONValue], JSONArray> = ([inputValue]) => {
    if (this.getTypeName(inputValue) === InputArgument.TYPE_ARRAY) {
      return inputValue as JSONArray;
    }
    return [inputValue];
  };

  private functionToNumber: RuntimeFunction<[JSONValue], number | null> = ([inputValue]) => {
    const typeName = this.getTypeName(inputValue);
    let convertedValue: number;
    if (typeName === InputArgument.TYPE_NUMBER) {
      return inputValue as number;
    }
    if (typeName === InputArgument.TYPE_STRING) {
      convertedValue = +(inputValue as string);
      if (!isNaN(convertedValue)) {
        return convertedValue;
      }
    }
    return null;
  };

  private functionToString: RuntimeFunction<[JSONValue], string> = ([inputValue]) => {
    if (this.getTypeName(inputValue) === InputArgument.TYPE_STRING) {
      return inputValue as string;
    }
    return JSON.stringify(inputValue);
  };

  private functionTrim: RuntimeFunction<JSONValue[], string> = resolvedArgs => {
    const subject = <string>resolvedArgs[0];
    return trim(subject, resolvedArgs.length > 1 ? <string>resolvedArgs[1] : undefined);
  };
  private functionTrimLeft: RuntimeFunction<JSONValue[], string> = resolvedArgs => {
    const subject = <string>resolvedArgs[0];
    return trimLeft(subject, resolvedArgs.length > 1 ? <string>resolvedArgs[1] : undefined);
  };
  private functionTrimRight: RuntimeFunction<JSONValue[], string> = resolvedArgs => {
    const subject = <string>resolvedArgs[0];
    return trimRight(subject, resolvedArgs.length > 1 ? <string>resolvedArgs[1] : undefined);
  };

  private functionType: RuntimeFunction<[JSONValue], string> = ([inputValue]) => {
    switch (this.getTypeName(inputValue)) {
      case InputArgument.TYPE_NUMBER:
        return 'number';
      case InputArgument.TYPE_STRING:
        return 'string';
      case InputArgument.TYPE_ARRAY:
        return 'array';
      case InputArgument.TYPE_OBJECT:
        return 'object';
      case InputArgument.TYPE_BOOLEAN:
        return 'boolean';
      case InputArgument.TYPE_NULL:
        return 'null';
      default:
        throw new Error('invalid-type');
    }
  };

  private functionUpper: RuntimeFunction<[string], string> = ([subject]) => {
    return upper(subject);
  };

  private functionValues: RuntimeFunction<[JSONObject], JSONValue[]> = ([inputObject]) => {
    return Object.values(inputObject);
  };

  private functionZip: RuntimeFunction<JSONArrayArray, JSONArray> = array => {
    const length = Math.min(...array.map(arr => arr.length));
    const result = Array(length)
      .fill(null)
      .map((_, index) => array.map(arr => arr[index]));
    return result;
  };

  private functionTable: FunctionTable = {
    abs: {
      _func: this.functionAbs,
      _signature: [
        {
          types: [InputArgument.TYPE_NUMBER],
        },
      ],
    },
    avg: {
      _func: this.functionAvg,
      _signature: [
        {
          types: [InputArgument.TYPE_ARRAY_NUMBER],
        },
      ],
    },
    ceil: {
      _func: this.functionCeil,
      _signature: [
        {
          types: [InputArgument.TYPE_NUMBER],
        },
      ],
    },
    contains: {
      _func: this.functionContains,
      _signature: [
        {
          types: [InputArgument.TYPE_STRING, InputArgument.TYPE_ARRAY],
        },
        {
          types: [InputArgument.TYPE_ANY],
        },
      ],
    },
    ends_with: {
      _func: this.functionEndsWith,
      _signature: [
        {
          types: [InputArgument.TYPE_STRING],
        },
        {
          types: [InputArgument.TYPE_STRING],
        },
      ],
    },
    find_first: {
      _func: this.functionFindFirst,
      _signature: [
        {
          types: [InputArgument.TYPE_STRING],
        },
        {
          types: [InputArgument.TYPE_STRING],
        },
        {
          types: [InputArgument.TYPE_NUMBER],
          optional: true,
        },
        {
          types: [InputArgument.TYPE_NUMBER],
          optional: true,
        },
      ],
    },
    find_last: {
      _func: this.functionFindLast,
      _signature: [
        {
          types: [InputArgument.TYPE_STRING],
        },
        {
          types: [InputArgument.TYPE_STRING],
        },
        {
          types: [InputArgument.TYPE_NUMBER],
          optional: true,
        },
        {
          types: [InputArgument.TYPE_NUMBER],
          optional: true,
        },
      ],
    },
    floor: {
      _func: this.functionFloor,
      _signature: [
        {
          types: [InputArgument.TYPE_NUMBER],
        },
      ],
    },
    from_items: {
      _func: this.functionFromItems,
      _signature: [
        {
          types: [InputArgument.TYPE_ARRAY_ARRAY],
        },
      ],
    },
    group_by: {
      _func: this.functionGroupBy,
      _signature: [{ types: [InputArgument.TYPE_ARRAY] }, { types: [InputArgument.TYPE_EXPREF] }],
    },
    items: {
      _func: this.functionItems,
      _signature: [
        {
          types: [InputArgument.TYPE_OBJECT],
        },
      ],
    },
    join: {
      _func: this.functionJoin,
      _signature: [
        {
          types: [InputArgument.TYPE_STRING],
        },
        {
          types: [InputArgument.TYPE_ARRAY_STRING],
        },
      ],
    },
    keys: {
      _func: this.functionKeys,
      _signature: [
        {
          types: [InputArgument.TYPE_OBJECT],
        },
      ],
    },
    length: {
      _func: this.functionLength,
      _signature: [
        {
          types: [InputArgument.TYPE_STRING, InputArgument.TYPE_ARRAY, InputArgument.TYPE_OBJECT],
        },
      ],
    },
    lower: {
      _func: this.functionLower,
      _signature: [
        {
          types: [InputArgument.TYPE_STRING],
        },
      ],
    },
    map: {
      _func: this.functionMap,
      _signature: [
        {
          types: [InputArgument.TYPE_EXPREF],
        },
        {
          types: [InputArgument.TYPE_ARRAY],
        },
      ],
    },
    max: {
      _func: this.functionMax,
      _signature: [
        {
          types: [InputArgument.TYPE_ARRAY_NUMBER, InputArgument.TYPE_ARRAY_STRING],
        },
      ],
    },
    max_by: {
      _func: this.functionMaxBy,
      _signature: [
        {
          types: [InputArgument.TYPE_ARRAY],
        },
        {
          types: [InputArgument.TYPE_EXPREF],
        },
      ],
    },
    merge: {
      _func: this.functionMerge,
      _signature: [
        {
          types: [InputArgument.TYPE_OBJECT],
          variadic: true,
        },
      ],
    },
    min: {
      _func: this.functionMin,
      _signature: [
        {
          types: [InputArgument.TYPE_ARRAY_NUMBER, InputArgument.TYPE_ARRAY_STRING],
        },
      ],
    },
    min_by: {
      _func: this.functionMinBy,
      _signature: [
        {
          types: [InputArgument.TYPE_ARRAY],
        },
        {
          types: [InputArgument.TYPE_EXPREF],
        },
      ],
    },
    not_null: {
      _func: this.functionNotNull,
      _signature: [
        {
          types: [InputArgument.TYPE_ANY],
          variadic: true,
        },
      ],
    },
    pad_left: {
      _func: this.functionPadLeft,
      _signature: [
        {
          types: [InputArgument.TYPE_STRING],
        },
        {
          types: [InputArgument.TYPE_NUMBER],
        },
        {
          types: [InputArgument.TYPE_STRING],
          optional: true,
        },
      ],
    },
    pad_right: {
      _func: this.functionPadRight,
      _signature: [
        {
          types: [InputArgument.TYPE_STRING],
        },
        {
          types: [InputArgument.TYPE_NUMBER],
        },
        {
          types: [InputArgument.TYPE_STRING],
          optional: true,
        },
      ],
    },
    replace: {
      _func: this.functionReplace,
      _signature: [
        {
          types: [InputArgument.TYPE_STRING],
        },
        {
          types: [InputArgument.TYPE_STRING],
        },
        {
          types: [InputArgument.TYPE_STRING],
        },
        {
          types: [InputArgument.TYPE_NUMBER],
          optional: true,
        },
      ],
    },
    split: {
      _func: this.functionSplit,
      _signature: [
        {
          types: [InputArgument.TYPE_STRING],
        },
        {
          types: [InputArgument.TYPE_STRING],
        },
        {
          types: [InputArgument.TYPE_NUMBER],
          optional: true,
        },
      ],
    },
    reverse: {
      _func: this.functionReverse,
      _signature: [
        {
          types: [InputArgument.TYPE_STRING, InputArgument.TYPE_ARRAY],
        },
      ],
    },
    sort: {
      _func: this.functionSort,
      _signature: [
        {
          types: [InputArgument.TYPE_ARRAY_STRING, InputArgument.TYPE_ARRAY_NUMBER],
        },
      ],
    },
    sort_by: {
      _func: this.functionSortBy,
      _signature: [
        {
          types: [InputArgument.TYPE_ARRAY],
        },
        {
          types: [InputArgument.TYPE_EXPREF],
        },
      ],
    },
    starts_with: {
      _func: this.functionStartsWith,
      _signature: [
        {
          types: [InputArgument.TYPE_STRING],
        },
        {
          types: [InputArgument.TYPE_STRING],
        },
      ],
    },
    sum: {
      _func: this.functionSum,
      _signature: [
        {
          types: [InputArgument.TYPE_ARRAY_NUMBER],
        },
      ],
    },
    to_array: {
      _func: this.functionToArray,
      _signature: [
        {
          types: [InputArgument.TYPE_ANY],
        },
      ],
    },
    to_number: {
      _func: this.functionToNumber,
      _signature: [
        {
          types: [InputArgument.TYPE_ANY],
        },
      ],
    },
    to_string: {
      _func: this.functionToString,
      _signature: [
        {
          types: [InputArgument.TYPE_ANY],
        },
      ],
    },
    trim: {
      _func: this.functionTrim,
      _signature: [
        {
          types: [InputArgument.TYPE_STRING],
        },
        {
          types: [InputArgument.TYPE_STRING],
          optional: true,
        },
      ],
    },
    trim_left: {
      _func: this.functionTrimLeft,
      _signature: [
        {
          types: [InputArgument.TYPE_STRING],
        },
        {
          types: [InputArgument.TYPE_STRING],
          optional: true,
        },
      ],
    },
    trim_right: {
      _func: this.functionTrimRight,
      _signature: [
        {
          types: [InputArgument.TYPE_STRING],
        },
        {
          types: [InputArgument.TYPE_STRING],
          optional: true,
        },
      ],
    },
    type: {
      _func: this.functionType,
      _signature: [
        {
          types: [InputArgument.TYPE_ANY],
        },
      ],
    },
    upper: {
      _func: this.functionUpper,
      _signature: [
        {
          types: [InputArgument.TYPE_STRING],
        },
      ],
    },
    values: {
      _func: this.functionValues,
      _signature: [
        {
          types: [InputArgument.TYPE_OBJECT],
        },
      ],
    },
    zip: {
      _func: this.functionZip,
      _signature: [
        {
          types: [InputArgument.TYPE_ARRAY],
          variadic: true,
        },
      ],
    },
  };
}

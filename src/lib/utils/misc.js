/*
 * Copyright 2021. F5 Networks, Inc. See End User License Agreement ("EULA") for
 * license terms. Notwithstanding anything to the contrary in the EULA, Licensee
 * may copy and modify this software product for its internal business purposes.
 * Further, Licensee may upload, publish and distribute the modified version of
 * the software product on devcentral.f5.com.
 */

'use strict';

const assignDefaults = require('lodash/defaultsDeep');
const cloneDeep = require('lodash/cloneDeep');
const clone = require('lodash/clone');
const hasKey = require('lodash/has');
const mergeWith = require('lodash/mergeWith');
const trim = require('lodash/trim');
const objectGet = require('lodash/get');
const childProcess = require('child_process');
const fs = require('fs');
const net = require('net');
// deep require support is deprecated for versions 7+ (requires node8+)
const uuidv4 = require('uuid/v4');
const jsonDuplicateKeyHandle = require('json-duplicate-key-handle');

/** @module miscUtil */
/* General helper functions (objects, primitives, etc)
*/

/**
 * Convert async callback function to promise-based funcs
 *
 * Note: when error passed to callback then all other args will be attached
 * to it and can be access via 'error.callbackArgs' property
 *
 * @property {Object} module - origin module
 * @property {String} funcName - function name
 *
 * @returns {Function<Promise>} proxy function
 */
function proxyForNodeCallbackFuncs(module, funcName) {
    return function () {
        return new Promise((resolve, reject) => {
            const args = Array.from(arguments);
            args.push(function () {
                const cbArgs = Array.from(arguments);
                // error usually is first arg
                if (cbArgs[0]) {
                    cbArgs[0].callbackArgs = cbArgs.slice(1);
                    reject(cbArgs[0]);
                } else {
                    resolve(cbArgs.slice(1));
                }
            });
            module[funcName].apply(module, args);
        });
    };
}

const VERSION_COMPARATORS = ['==', '===', '<', '<=', '>', '>=', '!=', '!=='];

const SECRETS_MASK = '*********';
const KEYWORDS_TO_MASK = [
    {
        /**
         * single line:
         *
         * { "passphrase": { ...secret... } }
         */
        str: 'passphrase',
        replace: /(\\{0,}["']{0,1}passphrase\\{0,}["']{0,1}\s*:\s*){.*?}/g,
        with: `$1{${SECRETS_MASK}}`
    },
    {
        /**
         * {
         *     "passphrase": "secret"
         * }
         */
        str: 'passphrase',
        replace: /(\\{0,}["']{0,1}passphrase\\{0,}["']{0,1}\s*:\s*)(\\{0,}["']{1}).*?\2/g,
        with: `$1$2${SECRETS_MASK}$2`
    },
    {
        /**
         * {
         *     someSecret: {
         *         cipherText: "secret"
         *     }
         * }
         */
        str: 'cipherText',
        replace: /(\\{0,}["']{0,1}cipherText\\{0,}["']{0,1}\s*:\s*)(\\{0,}["']{1}).*?\2/g,
        with: `$1$2${SECRETS_MASK}$2`
    }
];


module.exports = {
    /**
     * Assign defaults to object (uses lodash.defaultsDeep under the hood)
     * Note: check when working with arrays, as values may be merged incorrectly
     *
     * @param {Object} obj - object to assign defaults to
     * @param {...Object} defaults - defaults to assign to object
     *
     * @returns {Object}
     */
    assignDefaults,

    /**
     * Check if object has any data or not
     *
     * @param {any} obj - object to test
     *
     * @returns {Boolean} 'true' if empty else 'false'
     */
    isObjectEmpty(obj) {
        if (obj === undefined || obj === null) {
            return true;
        }
        if (Array.isArray(obj) || typeof obj === 'string') {
            return obj.length === 0;
        }
        /* eslint-disable no-restricted-syntax */
        for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                return false;
            }
        }
        return true;
    },

    /**
     * Copy object (uses lodash.clone under the hood)
     *
     * @param {any} obj - object to copy
     *
     * @returns {any} copy of source object
     */
    copy(obj) {
        return clone(obj);
    },

    /**
     * Deep Copy (uses lodash.cloneDeep under the hood).
     * Same as `copy` but copies entire object recursively
     *
     * @param {any} obj - object to copy
     *
     * @returns {any} deep copy of source object
     */
    deepCopy(obj) {
        return cloneDeep(obj);
    },


    /**
     * Merges an Array of Objects into a single Object (uses lodash.mergeWith under the hood).
     * Note: Nested Arrays are concatenated, not overwritten.
     * Note: Passed data gets *spoiled* - copy if you need the original data
     *
     * @param {Array} collection - Array of Objects to be merged.
     *
     * @returns {Object} Object after being merged will all other Objects in the passed Array, or empty object
     *
     * Example:
     *  collection: [
     *      { a: 12, b: 13, c: [17, 18] },
     *      { b: 14, c: [78, 79], d: 11 }
     *  ]
     *  will return:
     *  {
     *      a: 12, b: 14, c: [17, 18, 78, 79], d: 11
     *  }
     */
    mergeObjectArray(collection) {
        if (!Array.isArray(collection)) {
            throw new Error('Expected input of Array');
        }
        // eslint-disable-next-line consistent-return
        function concatArrays(objValue, srcValue) {
            if (Array.isArray(objValue)) {
                return objValue.concat(srcValue);
            }
        }

        for (let i = 1; i < collection.length; i += 1) {
            // only process elements that are Objects
            if (typeof collection[i] === 'object' && !Array.isArray(collection[i])) {
                mergeWith(collection[0], collection[i], concatArrays);
            }
        }
        // First Object in array has been merged with all other Objects - it has the complete data set.
        return collection[0] || {};
    },

    /**
     * Parses a JSON string into an object, while preserving any duplicate keys in the JSON object.
     * Duplicate keys convert the JSON key type to an array.
     *
     * Example:
     * input is { dup: 'yes', nonDup: 12, dup: { inside: 74 } }
     * returned object is { dup: ['yes', { inside: 74 } ], nonDup: 12 }
     *
     * @param {String}  data    - JSON data as a string
     *
     * @returns {Object}    Object with the parsed JSON data
     */
    parseJsonWithDuplicatekeys(data) {
        const arrayHandler = (keys, key, values, value) => {
            const existingKey = keys.indexOf(key.value);
            if (existingKey !== -1) {
                const existingValue = values[existingKey];
                if (Array.isArray(existingValue)) {
                    values[existingKey] = existingValue.concat(value.value);
                } else {
                    values[existingKey] = [existingValue].concat(value.value);
                }
            } else {
                keys.push(key.value);
                values.push(value.value);
            }
        };
        return jsonDuplicateKeyHandle.parse(data, arrayHandler);
    },

    /**
     * Return Node version without 'v'
     */
    getRuntimeInfo() {
        return { nodeVersion: process.version.substring(1) };
    },

    /**
     * Convert a string from camelCase to underscoreCase
     * Returns converted string
     */
    camelCaseToUnderscoreCase(str) {
        return str.split(/(?=[A-Z])/).join('_').toLowerCase();
    },

    /**
     * Compare version strings
     *
     * @param {String} version1   - version to compare
     * @param {String} comparator - comparison operator
     * @param {String} version2   - version to compare
     *
     * @returns {boolean} true or false
     */
    compareVersionStrings(version1, comparator, version2) {
        comparator = comparator === '=' ? '==' : comparator;
        if (VERSION_COMPARATORS.indexOf(comparator) === -1) {
            throw new Error(`Invalid comparator '${comparator}'`);
        }
        const v1parts = version1.split('.');
        const v2parts = version2.split('.');
        const maxLen = Math.max(v1parts.length, v2parts.length);
        let part1;
        let part2;
        let cmp = 0;
        for (let i = 0; i < maxLen && !cmp; i += 1) {
            part1 = parseInt(v1parts[i], 10) || 0;
            part2 = parseInt(v2parts[i], 10) || 0;
            if (part1 < part2) {
                cmp = 1;
            } else if (part1 > part2) {
                cmp = -1;
            }
        }
        // eslint-disable-next-line no-eval
        return eval(`0${comparator}${cmp}`);
    },

    /**
     * Stringify a message with option to pretty format
     *
     * @param {Object|String} msg - message to stringify
     * @param {Boolean} prettyFormat - format JSON string to make it easier to read
     * @returns {Object} Stringified message
     */
    stringify(msg, pretty) {
        if (typeof msg === 'object') {
            try {
                msg = pretty ? JSON.stringify(msg, null, 4) : JSON.stringify(msg);
            } catch (e) {
                // just leave original message intact
            }
        }
        return msg;
    },

    /**
     * Base64 helper
     *
     * @param {String} action - decode|encode
     * @param {String} data - data to process
     *
     * @returns {String} Returns processed data as a string
     */
    base64(action, data) {
        // just decode for now
        if (action === 'decode') {
            return Buffer.from(data, 'base64').toString().trim();
        }
        throw new Error('Unsupported action, try one of these: decode');
    },

    /**
     * Network check - with max timeout interval (5 seconds)
     *
     * @param {String} host               - host address
     * @param {Integer} port              - host port
     * @param {Object}  [options]         - options
     * @param {Integer} [options.timeout] - timeout before fail if unable to establish connection, by default 5s.
     * @param {Integer} [options.period]  - how often to check connection status, by default 100ms.
     *
     * @returns {Promise} Returns promise resolved on successful check
     */
    networkCheck(host, port, options) {
        let done = false;
        const connectPromise = new Promise((resolve, reject) => {
            const client = net.createConnection({ host, port })
                .on('connect', () => {
                    client.end();
                })
                .on('end', () => {
                    done = true;
                    resolve();
                })
                .on('error', (err) => {
                    done = 'error';
                    reject(err);
                });
        });

        options = this.assignDefaults(options, {
            period: 100,
            timeout: 5 * 1000
        });
        if (options.timeout <= options.period) {
            options.period = options.timeout;
        }
        const timeoutPromise = new Promise((resolve, reject) => {
            const interval = setInterval(() => {
                options.timeout -= options.period;

                const fail = () => {
                    clearInterval(interval);
                    reject(new Error(`unable to connect: ${host}:${port} (timeout exceeded)`)); // max timeout, reject
                };

                if (done === true) {
                    clearInterval(interval);
                    resolve(); // connection success, resolve
                } else if (done === 'error') {
                    fail();
                } else if (options.timeout <= 0) {
                    fail();
                }
            }, options.period);
        });

        return Promise.all([connectPromise, timeoutPromise])
            .then(() => true)
            .catch((e) => {
                throw new Error(`networkCheck: ${e}`);
            });
    },

    /**
     * Get random number from range
     *
     * @param {Number} min - left boundary
     * @param {Number} max - right boundary
     *
     * @returns {Number} random number from range
     */
    getRandomArbitrary(min, max) {
        return Math.random() * (max - min) + min;
    },

    /**
     * Rename keys in an object at any level of depth if it passes the given regular expression test.
     *
     * @param {Object}                target         - object to be modified
     * @param {Regular Expression}    match          - regular expression to test
     * @param {String}                replacement    - regular expression match replacement
     */
    renameKeys(target, match, replacement) {
        if (target !== null && typeof target === 'object') {
            Object.keys(target).forEach((member) => {
                this.renameKeys(target[member], match, replacement);
                if (match.test(member)) {
                    const newMember = member.replace(match, replacement);
                    target[newMember] = target[member];
                    delete target[member];
                }
            });
        }
    },

    /**
     * Trim a specific character or string from the beginning or end of a string
     *
     * @param {String}  string      - The full string to be trimmed
     * @param {String}  toRemove    - The character or string to remove
     *
     * @returns {String}    The trimmed string
     */
    trimString(string, toRemove) {
        return trim(string, toRemove);
    },

    /**
     * Generate a random UUID (v4 RFC4122)
     * Uses uuid.v4 under the hood
     *
     * @returns {String}    The UUID value
     */
    generateUuid() {
        return uuidv4();
    },

    /**
     * Convenience method to get value of property on an object given a path
     * Uses lodash.get under the hood
     *
     * @param {Object}  object              - the object to query
     * @param {Array|String}  propertyPath  - property path (e.g. child1.prop1[0].child2)
     * @param {*} defaultValue              - the value to return if property not found. default is undefined
     *
     * @returns {*}    Resolved value of the object property
     */
    getProperty(object, propertyPath, defaultValue) {
        return objectGet(object, propertyPath, defaultValue);
    },

    /**
     * Sleep for N ms.
     *
     * @returns {Promise} resolved once N .ms passed or rejected if canceled via .cancel()
     */
    sleep(sleepTime) {
        /**
         * According to http://www.ecma-international.org/ecma-262/6.0/#sec-promise-executor
         * executor will be called immediately (synchronously) on attempt to create Promise
         */
        let cancelCb;
        const promise = new Promise((resolve, reject) => {
            const timeoutID = setTimeout(() => {
                cancelCb = null;
                resolve();
            }, sleepTime);
            cancelCb = (reason) => {
                cancelCb = null;
                clearTimeout(timeoutID);
                reject(reason || new Error('canceled'));
            };
        });
        /**
         * @param {Error} [reason] - cancellation reason
         *
         * @returns {Boolean} 'true' if cancelCb called else 'false'
         */
        promise.cancel = (reason) => {
            if (cancelCb) {
                cancelCb(reason);
                return true;
            }
            return false;
        };
        return promise;
    },

    /**
     * Mask Secrets (as needed)
     *
     * @param {String} msg - message to mask
     *
     * @returns {String} Masked message
     */
    maskSecrets(msg) {
        let ret = msg;
        // place in try/catch
        try {
            KEYWORDS_TO_MASK.forEach((keyword) => {
                if (msg.indexOf(keyword.str) !== -1) {
                    ret = ret.replace(keyword.replace, keyword.with);
                }
            });
        } catch (e) {
            // just continue
        }
        return ret;
    },

    /**
     * Generates a unique property name that the object doesn't have
     *
     * - 'originKey' will be returned if it doesn't exist in the object
     *
     * @param {object} object - object
     * @param {string} originKey - origin key
     *
     * @returns {string} unique key
     */
    generateUniquePropName(object, originKey) {
        // flexibility for args can be added later
        const sep = '';
        let startIdx = 0;

        if (!hasKey(object, originKey)) {
            return originKey;
        }
        while (hasKey(object, `${originKey}${sep}${startIdx}`)) {
            startIdx += 1;
        }
        return `${originKey}${sep}${startIdx}`;
    },

    /**
     * Promisified 'child_process'' module
     *
     * @see fs
     */
    childProcess: (function promisifyNodeChildProcessModule(cpModule) {
        const newCpModule = Object.create(cpModule);
        ['exec', 'execFile'].forEach((key) => {
            newCpModule[key] = proxyForNodeCallbackFuncs(cpModule, key);
        });
        return newCpModule;
    }(childProcess)),

    /**
     * Promisified 'fs' module
     *
     * @see fs
     */
    fs: (function promisifyNodeFsModule(fsModule) {
        const newFsModule = Object.create(fsModule);
        Object.keys(fsModule).forEach((key) => {
            if (typeof fsModule[`${key}Sync`] !== 'undefined') {
                newFsModule[key] = proxyForNodeCallbackFuncs(fsModule, key);
            }
        });
        return newFsModule;
    }(fs))
};

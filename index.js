/* global require, console, module, Buffer */

'use strict'
var assert = require('assert')
var extract = require('url-querystring')
var filendir = require('filendir')
var fs = require('fs')
var getRawBody = require('raw-body')
var MD5 = require("crypto-js/md5");
var objectAssign = require('object-assign')
var omit = require('object.omit')
var packageJson = require('./package.json')
var path = require('path')
var request = require('request')
var sanitize = require('sanitize-filename')
var zlib = require('zlib')
const util = require('util');
var crypto = require('crypto')

function encrypt(buffer) {
	var name = 'braitsch';
	var hash = crypto.createHash('md5').update(buffer).digest('hex');
	return hash;
}

var MODULE_NAME = 'api-cache-proxy'

var log = console.log.bind(console, '[' + MODULE_NAME + '] ')

var defaultConfig = {
	apiUrl: '',
	cacheEnabled: true,
	cacheDir: 'api-cache/',
	excludeRequestHeaders: [],
	excludeRequestParams: [],
	excludeEndpoints: [],
	isValidResponse: function (envelope) {
		if (envelope.statusCode === 200) {
			return true
		} else {
			return false
		}
	},
	localURLReplace: function (url) {
		return url
	},
	timeout: false
}

objectAssign(APICache.prototype, {
	_createEnvelope: function (response, responseBody, requestBody) {
		var excludeRequestHeaders = [
			'content-encoding', // content is unpacked, content-encoding doesn't apply anymore,
			'content-length', // when content is uncpacked, content-length is different.
			'connection',
			'transfer-encoding'
		]
		excludeRequestHeaders.push.apply(excludeRequestHeaders, this.config.excludeRequestHeaders)
		var headers = omit(response.headers, excludeRequestHeaders)

		return {
			cacheDate: new Date().toISOString().substr(0, 19).replace('T', ' '),
			reqURL: this._clearURLParams(response.request.href),
			reqMethod: response.request.method,
			reqHeaders: response.request.headers,
			reqBody: requestBody,

			body: responseBody,
			headers: headers,
			statusCode: response.statusCode,
			statusMessage: response.statusMessage,
			version: packageJson.version
		}
	},

	onResponse: function (apiResponse, res, requestBody, resolve, reject) {
		var body = []

		apiResponse.on('data', function (chunk) {
			// Data is Buffer when gzip, text when not-gzip
			body.push(chunk)
		})

		apiResponse.on('end', function () {
			// Thanks, Nick Fishman
			// http://nickfishman.com/post/49533681471/nodejs-http-requests-with-gzip-deflate-compression
			var encoding = apiResponse.headers['content-encoding']
			var buffer = Buffer.concat(body)
			if (encoding === 'gzip') {
				body = zlib.gunzipSync(buffer)
			} else if (encoding == 'deflate') {
				body = zlib.inflateSync(buffer)
			} else {
				body = buffer
			}
			body = body ? body.toString() : ''

			var envelope = this._createEnvelope(apiResponse, body, requestBody)

			// this.sendCachedResponse(res, envelope, resolve, reject)
			if (this.config.isValidResponse(envelope)) {
				this._saveRequest(envelope)
				console.log('Readed API: ' + envelope.reqURL)
				this.sendResponse(res, envelope.statusCode, envelope.headers, envelope.body)
				resolve({
					dataSource: "API",
					envelope: envelope
				})
			} else {
				this.sendCachedResponse(res, envelope, resolve, reject)
			}
		}.bind(this))
	},
	checkCache: function (res, reqMethod, reqBody, reqURL) {

		if (this._inExcludedEndpoint(reqURL) === true){
			console.log('Excluded: ' + reqURL);
			return false;
		}

		var url = this._clearURLParams(reqURL);
		var filePath = this._getFileName(reqMethod, reqBody, url);
		if (fs.existsSync(filePath) && !res.headersSent) { // in case of custom error handling in promise.catch
			var data = fs.readFileSync(filePath, 'utf-8')
			var cachedEnvelope = JSON.parse(data)
			if (cachedEnvelope.version !== packageJson.version) {
				throw new Error("Request envelope created in old plugin version.")
			}
			console.log('Readed cache: ' + url);

			var headers = cachedEnvelope.headers
			headers[MODULE_NAME + '-hit-date'] = cachedEnvelope.cacheDate
			res.writeHead(200, headers);
			res.end(cachedEnvelope.body);
			return true;
		}

		return false;
	},
	sendCachedResponse: function (res, envelope, resolve, reject) {
		var cachedEnvelope,
			filePath = this._getFileName(envelope.reqMethod, envelope.reqBody, envelope.reqURL)

		try {
			var data = fs.readFileSync(filePath, 'utf-8')
			cachedEnvelope = JSON.parse(data)
			if (cachedEnvelope.version !== packageJson.version) {
				throw new Error("Request envelope created in old plugin version.")
			}
		} catch (e) {
			reject(envelope)
			this.sendResponse(res, envelope.statusCode, envelope.headers, envelope.body)
			return false
		}

		var headers = cachedEnvelope.headers
		headers[MODULE_NAME + '-hit-date'] = cachedEnvelope.cacheDate

		resolve({
			dataSource: "Cache",
			filePath: filePath,
			envelope: cachedEnvelope
		})
		this.sendResponse(res, cachedEnvelope.statusCode, headers, cachedEnvelope.body)
	},

	sendResponse: function (res, statusCode, headers, body) {
		if (!res.headersSent) { // in case of custom error handling in promise.catch
			res.writeHead(statusCode ? statusCode : 500, headers);
			res.end(body)
		}
	},

	/**
	 * clearURL takes url string as input and remove parameters, that are
	 * listed in config.excludeRequestParams
	 * @param	{string} href
	 * @return {string}
	 */
	_clearURLParams: function (href) {
		var url = extract(href)
		var queryObj = omit(url.qs, this.config.excludeRequestParams)

		var desiredUrlParams = Object.keys(queryObj).map(function (paramName) {
			return paramName + '=' + encodeURIComponent(queryObj[paramName])
		}).join('&')

		return desiredUrlParams ? url.url + '?' + desiredUrlParams : url.url
	},

	_inExcludedEndpoint: function (href) {
		var isExcluded = false;
		this.config.excludeEndpoints.forEach(element => {
			if (href.indexOf(element) != -1) {
				isExcluded = true;
				return;
			}
		});
		return isExcluded;
	},

	_getFileName: function (reqMethod, reqBody, reqURL) {

		var bodyHash = ''
		if (reqMethod !== 'GET') {
			bodyHash = ' ' + MD5(JSON.stringify(reqBody))
		}

		var sanitazedURL = sanitize(reqURL.replace('://', '-'), { replacement: '-' })
		var hw = encrypt(reqMethod + '_' + sanitazedURL + bodyHash);

		var fileName = hw + '.tmp'

		return path.resolve(this.config.cacheDir, fileName)
	},

	/**
	 * Save request to file
	 * @param	{object} envelope
	 * @return {none}
	 */
	_saveRequest: function (envelope) {
		var filePath = this._getFileName(envelope.reqMethod, envelope.reqBody, envelope.reqURL)

		filendir.writeFile(filePath, JSON.stringify(envelope), function (err) {
			if (err) {
				console.log('File could not be saved in ' + this.config.cacheDir)
				throw err
			} else {
				fs.chmodSync(filePath, parseInt('0777', 8));
				console.log('Write cache: ' + filePath);
			}
		}.bind(this))
	},

	onError: function (err, apiReq, res, requestBody, resolve, reject) {
		var envelope = { // this envelope is used just in _getFileName
			reqMethod: apiReq.method,
			reqURL: this._clearURLParams(apiReq.url || apiReq.href),
			reqBody: requestBody
		}

		this.sendCachedResponse(res, envelope, resolve, reject)
	},

	/**
	 * POST, PUT methods' payload need to be taken out from request object.
	 * @param  {object} req Request object
	 */
	_getRequestBody: function (req, returnReference) {
		getRawBody(req).then(function (bodyBuffer) {
			returnReference.requestBody = bodyBuffer.toString()
		}.bind(this)).catch(function () {
			log('Unhandled error in getRawBody', arguments)
		})
	},

	_getApiURL: function (req) {
		var url = req.url.split('/')
		var newURL = this.config.apiUrl.replace(/\/+$/, '')
		if (url[0] === '') {
			// local path, like "/api/getToken"
			url[0] = newURL
		} else {
			// remote address, like "http://localhost:8080/api/getToken"
			url.splice(0, 3) // remove local protocol and domain part
			url.unshift(newURL) // push destination api url
		}

		url = url.join('/')
		return this.config.localURLReplace(url)
	}
})
/**
 * @constructor APICache
 * @param {[type]} config [description]
 */
function APICache(config) {
	assert(config, 'APICache requres config provided')
	assert(config.apiUrl, 'APICache: provide apiUrl')

	this.config = objectAssign({}, defaultConfig, config)

	var handleRequest = function (req, res) {
		var reqBodyRef = {
			requestBody: ''
		}
		this._getRequestBody(req, reqBodyRef)

		var url = this._getApiURL(req)
		var promise = new Promise(function (resolve, reject) {
			var apiReq = request(url)

			//first check cache if not, continue as always
			if (!this.checkCache(res, apiReq.method, reqBodyRef.requestBody, url)) {
				if (this.config.cacheEnabled) {
					req
						.pipe(apiReq)
						.on('response', function (response) {
							this.onResponse(response, res, reqBodyRef.requestBody, resolve, reject)
						}.bind(this))
						.on('error', function (err) {
							this.onError(err, apiReq, res, reqBodyRef.requestBody, resolve, reject)
							promise.catch(function () {
								log('API Error', url, err)
							})
						}.bind(this))
				} else {
					req.pipe(apiReq).pipe(res)
					apiReq.on('response', function () {
						resolve({ dataSource: "API" })
					})
					apiReq.on('error', function (err) {
						reject(err)
					})
				}
				if (this.config.timeout) {
					setTimeout(function () {
						apiReq.abort()
					}, this.config.timeout)
				}
			}
		}.bind(this))

		return promise['catch'](function (err) {});
	}

	return objectAssign(handleRequest.bind(this), this)
}

module.exports = APICache

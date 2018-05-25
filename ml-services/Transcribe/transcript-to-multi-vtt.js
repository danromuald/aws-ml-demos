// script to read a transcribe output JSON for a movie and create multiple subtitle files (WebVTT)
// we use Translate to get from English to Spanish
'use strict';

const fs = require('fs');
const AWS = require('aws-sdk');

// a custom dictionary for a given customer's use cases
const DICTIONARY = JSON.parse(fs.readFileSync('dict.json'));
const LANGUAGES = ['es'];

AWS.config.region = 'us-east-1';
const Translate = new AWS.Translate();

// Tokens to ensure we stay within a certain call rate ----------------------------------------
// TODO:  use a library so we don't need this

const MAX_CONCURRENT_SEQUENCES = 3;

let lastUsedTS = 0;

// wait waitBetweenChecksMillis and only execute f when we have a free token
function waitOnTokens(waitBetweenChecksMillis, f) {

	let intervalHandle = setInterval(function() {

		if (processTokens > 0) {

			processTokens--;
			lastUsedTS = Date.now();
			clearInterval(intervalHandle);
			// console.log(processTokens)
			f.call();
		}

	}, waitBetweenChecksMillis);
}

// wait waitBetweenChecksMillis and only execute f when all tokens are returned
function waitOnAllReturned(waitBetweenChecksMillis, f) {

	let intervalHandle = setInterval(function() {

		if ((tokensInUse() == 0) && (Date.now() > (lastUsedTS + waitBetweenChecksMillis))) {

			clearInterval(intervalHandle);
			// console.log(processTokens)
			f.call();
		}

	}, waitBetweenChecksMillis);
}

function returnToken() {

	processTokens++;
}

function tokensInUse() {

	return MAX_CONCURRENT_SEQUENCES - processTokens;
}

let processTokens = MAX_CONCURRENT_SEQUENCES;
// -------------------------------------------------------------------------------------------

const transcriptFile = process.argv[2];

if (! transcriptFile) {

	console.error('');
	console.error('ERROR:  please specify name of transcript file (from Amazon Transcribe)');
	process.exit(1);
}

function translateEn(daText, targetLanguageCode, callback) {

	Translate.translateText({
		"Text": daText,
		"SourceLanguageCode": 'en',
		"TargetLanguageCode": targetLanguageCode
	}, callback);
}

let transcript = JSON.parse(fs.readFileSync(transcriptFile));

function regulateTerm(term) {

	if (DICTIONARY[term])
		return DICTIONARY[term];
	else
		return term;
}

// given an offset in milliseconds, return an offset like 00:00:00.000
function formatMillisOffset(secsOffset) {

	let hours = 0,
		mins = 0,
		secs = 0,
		millis = 0;
	let millisOffset = secsOffset * 1000;

	// hours, minutes, seconds, milliseconds
	// 1000 ms = 1 s; 60 s = 1 min; 60 min = 1 hour
	hours = Math.floor(millisOffset / 3600000);
	mins = Math.floor((millisOffset % 3600000) / 60000);
	secs = Math.floor((millisOffset % 60000) / 1000);
	// ah, decimal approximation
	millis = Math.ceil(millisOffset % 1000);

	// return a formatted/zero padded string
	return `${(hours>9 ? hours : '0' + hours)}:${(mins>9 ? mins : '0' + mins)}:${(secs>9 ? secs : '0' + secs)}.${'0'.repeat(2 - Math.floor(Math.log10(Math.max(millis, 1))))}${millis}`;
}

let result = '';
let previousTime = 0;
let lastPause = 0;
let chunk = 1;
let lineTerms = 0;
let originalSentence = {
	sentenceText: '',
	// translations are available as separate attributes
	translations: {},
	chunkIds: [],
	chunks: []
};
let originalTranscript = new Array();
for (let i=0; (i < transcript.results.items.length); i++) {

	let item = transcript.results.items[i];

	if ((item.type == 'punctuation') && (result.substr(-1) == ' ' || result.substr(-1) == '\n')) {

		result = result.slice(0, -1);
	}

	// is there an apparent pause in the speech?
	let inferredEndOfSentence = ((item.start_time) && ((item.start_time - previousTime) > 0.9));

	// add a break if there's obviously a pause or after every 3 seconds
	if ((lineTerms == 0) ||
		inferredEndOfSentence ||
		((item.start_time) && ((item.start_time - lastPause) > 3))) {

		lastPause = item.start_time;

		// finish up the previous chunk
		if (chunk > 1) {
			result += '\n\n';
		} else {
			result += 'WEBVTT\n\n';
		}

		result += `${chunk}\n`;
		// let's keep things on the screen for three seconds, assuming that the interpreter handles the situation
		// when the next chunk is expected to appear earlier
		result += `${formatMillisOffset(item.start_time)} --> ${formatMillisOffset(parseInt(item.start_time, 10) + 3)}\n`;
		chunk++;
		lineTerms = 1;
	}
	if (item.end_time) {

		previousTime = item.end_time;
	}

	// first, try to use three terms
	let confidence = (item.alternatives[0].confidence ? item.alternatives[0].confidence : 1);
	let term = regulateTerm(item.alternatives[0].content);
	// TODO:  do this as lookahead(N-gram-count)
	let correctionFound = false;
	if ((i + 2) < transcript.results.items.length) {

		// we can look up to two terms ahead; try it
		let item2 = transcript.results.items[i + 1];
		let item3 = transcript.results.items[i + 2];
		let trigram = item.alternatives[0].content +
			((item2.type == 'punctuation') ? item2.alternatives[0].content : ' ' + item2.alternatives[0].content) +
			((item3.type == 'punctuation') ? item3.alternatives[0].content : ' ' + item3.alternatives[0].content);
		let proposedTerm = regulateTerm(trigram);
		// did we find a correction?
		if (proposedTerm != trigram) {

			// console.error(`found a correction - ${proposedTerm}`);
			correctionFound = true;
			term = proposedTerm;
			confidence = Math.min((item.alternatives[0].confidence ? item.alternatives[0].confidence : 1),
				(item2.alternatives[0].confidence ? item2.alternatives[0].confidence : 1),
				(item3.alternatives[0].confidence ? item3.alternatives[0].confidence : 1));
			i += 2;
		}
	}

	if ((! correctionFound) && ((i + 1) < transcript.results.items.length)) {

		// we can look up to one term ahead; try it
		let item2 = transcript.results.items[i + 1];
		let bigram = item.alternatives[0].content +
			((item2.type == 'punctuation') ? item2.alternatives[0].content : ' ' + item2.alternatives[0].content);
		let proposedTerm = regulateTerm(bigram);
		// did we find a correction?
		if (proposedTerm != bigram) {

			// console.error(`found a correction - ${proposedTerm}`);
			correctionFound = true;
			term = proposedTerm;
			confidence = Math.min((item.alternatives[0].confidence ? item.alternatives[0].confidence : 1),
				(item2.alternatives[0].confidence ? item2.alternatives[0].confidence : 1));
			i++;
		}
	}

	let textClass = 'unsure';
	if (confidence > 0.5)
		textClass = 'five';
	if (confidence > 0.6)
		textClass = 'six';
	if (confidence > 0.7)
		textClass = 'seven';
	if (confidence > 0.8)
		textClass = 'eight';

	if (confidence > 0.9) {

		result += `${term} `;
	} else {

		// look ahead before adding a space
		result += `<c.${textClass}>${term} </c>`;
	}
	if (((lineTerms % 7) == 0) || ((lineTerms > 1) && (item.type == 'punctuation'))) {

		result += '\n';
		lineTerms = 1;
	}
	lineTerms++;


	// collect sentences & chunks for our translation ---------------------------------------------------------
	if (item.type == 'punctuation') {

		originalSentence.sentenceText += term;
		// console.log(`${chunk} ${JSON.stringify(originalSentence)}`);
		originalTranscript.push(originalSentence);
		originalSentence = {
			sentenceText: '',
			translations: {},
			chunkIds: [],
			chunks: []
		};

	} else if ((inferredEndOfSentence && (originalSentence.sentenceText != '')) ||
		(originalSentence.sentenceText.length > 4900)) {

		// console.log(`${chunk} ${JSON.stringify(originalSentence)}`);
		originalTranscript.push(originalSentence);
		originalSentence = {
			sentenceText: term,
			translations: {},
			chunkIds: [],
			chunks: []
		};

	} else {

		originalSentence.sentenceText += ` ${term}`;
		// TODO:  this is needless; do it once rather than on every term
		if (originalSentence.chunkIds.indexOf(chunk - 1) == -1) {

			originalSentence.chunkIds.push(chunk - 1);
			originalSentence.chunks.push({
				chunkNum: chunk - 1,
				chunkTime: lastPause
			});
		}
	}
	// end collect sentences & chunks for our translation -----------------------------------------------------
}

// push the last piece of the transcript
if (originalSentence.sentenceText.length > 0) {

	originalTranscript.push(originalSentence);
}

// print out the EN VTT
console.log(result);

// console.error(JSON.stringify(originalTranscript));

// translate each sentence to the corresponding languageCode (e.g., es) sentence
function translate(languageCode) {
	originalTranscript.forEach(originalSentence => {

		waitOnTokens(500, function() {

			translateEn(originalSentence.sentenceText, languageCode,
				function(err, data) {

					if (err) {

						console.error('translate failed');
						console.error(JSON.stringify(data));
						console.error(err);
						// make sure we return the token
						returnToken();
						throw err;

					} else {

						// console.log(JSON.stringify(originalSentence));
						// console.error(`translateEn:  ${JSON.stringify(data)}`);
						originalSentence.translations[languageCode] = data.TranslatedText;
						// make sure we return the token
						returnToken();
					}
				});
		});
	});
}

// print out the VTT chunks for the corresponding languageCode sentence here
function toVTT(originalSentence, lastChunk, languageCode) {

	let result = '';
	// how many terms do we have in the sentenceText?
	let terms = originalSentence.translations[languageCode].split(' ');
	// favor earlier chunks by rounding up
	let termsPerChunk = Math.ceil(terms.length / originalSentence.chunkIds.length);
	let i = 0;

	// spread them across the chunks
	originalSentence.chunks.forEach(chunk => {

		if (chunk.chunkNum != lastChunk) {

			// we're starting a new chunk
			result += `${((chunk.chunkNum > 1) ? '\n\n' : '')}${chunk.chunkNum}\n`;
			result += `${formatMillisOffset(chunk.chunkTime)} --> ${formatMillisOffset(parseInt(chunk.chunkTime, 10) + 3)}\n`;

		} else {

			// we're adding to an existing chunk
		}

		// add the terms for this chunk
		let lineTerms = 1;
		for (let j = (i * termsPerChunk);
			(j < Math.min(((i + 1) * termsPerChunk), terms.length)); j++) {

			// break a line after every seven terms
			if ((lineTerms % 7) == 0) {

				result += '\n';
			}
			result += ` ${terms[j]}`;
			lineTerms++;
		}
		i++;
	});

	return result;
}

// translate to the required languages
LANGUAGES.forEach(languageCode => {

	translate(languageCode);
});

// when all the translations are available, start writing out the translated VTTs
waitOnAllReturned(3000, function() {

	LANGUAGES.forEach(languageCode => {

		let lastChunk = 0;
		console.log('\nWEBVTT\n');
		originalTranscript.forEach(originalSentence => {

			// console.log(JSON.stringify(originalSentence));
			console.log(toVTT(originalSentence, lastChunk, languageCode));
			lastChunk = originalSentence.chunkIds[originalSentence.chunkIds.length - 1];
		});

	});
});

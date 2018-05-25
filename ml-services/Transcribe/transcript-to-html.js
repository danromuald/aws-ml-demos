/*
	Script to combine an audio or video file with its Transcribe & Comprehend output.
*/
const AWS = require('aws-sdk');
const fs = require('fs');

// a custom dictionary for a given customer's use cases
const DICTIONARY = JSON.parse(fs.readFileSync('dict.json'));

AWS.config.region = 'us-east-1';
const Comprehend = new AWS.Comprehend();

const transcriptFile = process.argv[2];
const mediaFile = process.argv[3];
const mediaType = process.argv[4];

if (!transcriptFile) {

	showUsageAndQuit('ERROR:  please specify the name of the transcript file (from Amazon Transcribe)');
}
if (!mediaFile) {

	showUsageAndQuit('ERROR:  please specify the name of the media file');
}
if (!mediaType) {

	showUsageAndQuit('ERROR:  please specify the media type');
}

let transcript = JSON.parse(fs.readFileSync(transcriptFile));

// Tokens to ensure we stay within a certain call rate ----------------------------------------
// TODO:  use a library so we don't need this

const MAX_CONCURRENT_SEQUENCES = 1;

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

function showUsageAndQuit(errMessage) {

	console.error('');
	console.error(errMessage);
	console.log('\nUsage:');
	console.log(`\t${process.argv[1]} <transcriptFile> <mediaFile> <mediaType>`);
	process.exit(1);
}

function regulateTerm(term) {

	if (DICTIONARY[term])
		return DICTIONARY[term];
	else
		return term;
}

// given an offset in milliseconds, return an offset like 00:00:00,000
function formatMillisOffset(secsOffset) {

	let hours=0, mins=0, secs=0, millis=0;
	let millisOffset = secsOffset * 1000;

	// hours, minutes, seconds, milliseconds
	// 1000 ms = 1 s; 60 s = 1 min; 60 min = 1 hour
	hours = Math.floor(millisOffset / 3600000);
	mins = Math.floor((millisOffset % 3600000) / 60000);
	secs = Math.floor((millisOffset % 60000) / 1000);
	// ah, decimal approximation
	millis = Math.ceil(millisOffset % 1000);

	// return a formatted/zero padded string
	if (millis == 0) {
		return `${(hours>9 ? hours : '0' + hours)}:${(mins>9 ? mins : '0' + mins)}:${(secs>9 ? secs : '0' + secs)},000`;
	} else {
		return `${(hours>9 ? hours : '0' + hours)}:${(mins>9 ? mins : '0' + mins)}:${(secs>9 ? secs : '0' + secs)},${'0'.repeat(2 - Math.floor(Math.log10(millis)))}${millis}`;
	}
}

function nlpChunk(text) {

	// console.error(`nlpChunk(text) length is ${text.length}`);
	return {
		text:  text,
		entities:  null
	};
}

function collectMetrics(timeOffset, confidence) {

	let timeIndex = Math.floor(timeOffset / 10);
	if (! metrics[timeIndex]) {

		// initialize the entry if needed
		metrics[timeIndex] = { timeIndex:  formatMillisOffset(timeOffset), confidenceSum: 0.0, termCount: 0, unsureTermCount: 0 };
	}
	confidence = parseFloat(confidence);
	metrics[timeIndex].confidenceSum += confidence;
	metrics[timeIndex].termCount += 1;
	if (confidence < 0.5) {

		metrics[timeIndex].unsureTermCount += 1;
	}
}

function getSpeakerLabel(speakerSegments, startTime) {

	if (speakerSegments == null) {

		return null;
	} else {

		// look for the matching segment in speakerSegments
		let speaker = null;
		for (let i=0; (i < speakerSegments.length); i++) {

			if ((startTime >= speakerSegments[i].startTime) && (startTime <= speakerSegments[i].endTime)) {

				// console.error(speakerSegments[i].speaker);
				speaker = speakerSegments[i].speaker;
				break;
			}
		}

		return speaker;
	}
}

// use speaker_labels to initialize the speaker segments (if available)
let speaker_labels = (transcript.results.speaker_labels ? transcript.results.speaker_labels : null);
let speakersAvailable = (speaker_labels != null);
let speakerSegments = [];
if (speaker_labels != null) {

	speaker_labels.segments.forEach(segment => {

		let speakerSegment = {
			startTime:  parseFloat(segment.start_time),
			endTime:  parseFloat(segment.end_time),
			speaker:  segment.speaker_label
		};
		// console.error(JSON.stringify(speakerSegment));
		speakerSegments.push(speakerSegment);
	});
}

let nlpChunks = [];
// collect metrics in 10-second increments; each entry is essentially a collection of terms discovered in that range
let metrics = [];
let chunkText = '';
let result = '';
let previousTime = 0;
let lastPause = 0;
let lastSpeaker = null;
let speaker = null;

for (let i=0; (i < transcript.results.items.length); i++) {

	let item = transcript.results.items[i];
	if (item.type == 'punctuation') {

		result = result.slice(0, -1);
	}

	// try to identify the current speaker (leave at previous speaker for punctuations)
	speaker = ((speakersAvailable && item.start_time) ? getSpeakerLabel(speakerSegments, item.start_time) : speaker);

	// add a break if there's obviously a pause or if the speaker changes or after every 3 seconds
	if ((result == '') ||
		(speaker != lastSpeaker) ||
		((item.start_time) && ((item.start_time - previousTime) > 0.9)) ||
		((item.start_time) && ((item.start_time - lastPause) > 3))) {

		result += '\n<br>';
		let speakerLabel = ((speaker != null) && (speaker == lastSpeaker) ? "_____" :
			((speaker == null) ? '' : speaker));
		result += `<span class="ti" onclick="setTimeIndex(${Math.floor(item.start_time)})">[${formatMillisOffset(item.start_time)}] ${speakerLabel} </span>`;
		lastPause = item.start_time;
		lastSpeaker = (speakersAvailable ? getSpeakerLabel(speakerSegments, item.start_time) : null);
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

	let textColor = '#999';
	if (confidence > 0.5)
		textColor = '#aaa';
	if (confidence > 0.6)
		textColor = '#999';
	if (confidence > 0.7)
		textColor = '#666';
	if (confidence > 0.8)
		textColor = '#333';

	// TODO:  technically, speakers can change per word
	if (confidence > 0.9) {

		result += `${term} `;
	} else {

		result += `<span style="color: ${textColor}">${term}</span> `;
	}

	// collect the chunk of text for Comprehend
	// chunk it so we're well below the 5000-character limit
	if ((item.type == 'punctuation') || (chunkText.length > 4900)) {

		chunkText = chunkText.slice(0, -1);
		chunkText += term + ' ';
		if (chunkText.length > 4500) {

			nlpChunks.push(nlpChunk(chunkText));
			chunkText = '';
		}

	} else {

		chunkText += term + ' ';
	}

	// collect metrics in 10-second increments; each entry is essentially a collection of terms discovered in that range
	collectMetrics(item.start_time, parseFloat(confidence));
}

// push the last chunkText
if (chunkText.length > 0) {

	nlpChunks.push(nlpChunk(chunkText));
}

let header = '<html><head><style type="text/css"> span.ti { color: #aaa; padding-right: 10px; width: 150px; display: inline-block }' +
	'span.ti:hover { color: #77f; padding-right: 10px }' +
	'video#vplayr {width: 800px; padding: 10px} '+
	'audio#aplayr {width: 800px; padding: 10px} '+
	'video::cue { color: #fff; background-color: rgba(0, 0, 0, 0.75); }' +
	'video::cue(.unsure) { color: #444; }' +
	'video::cue(.five) { color: #666; }' +
	'video::cue(.six) { color: #888; }' +
	'video::cue(.seven) { color: #aaa; }' +
	'video::cue(.eight) { color: #ddd; }' +
	// get around a div top positioning issue with a white border
	'div#container {width:  100%; border: 1px solid #fff}' +
	'div#transcript {width:  800px; height:  600px; overflow: auto; border-top: 1px solid #77f; border-bottom: 1px solid #77f; margin: 6px; padding: 4px; float: left}' +
	'div#nlp {width:  550px; height:  600px; overflow: auto; background-color: #fffabd; margin: 6px; padding: 4px}' +
	'table#entities { padding: 2px; width: 100% }' +
	'table#entities tr { width:  98%, display: table }' +
	'table#entities th { border-top: 1px solid #bcba7d; border-bottom: 1px solid #bcba7d; text-align: left }' +
	'table#entities thead {display: table; width: 98%}' +
	'table#entities thead tr {display: block}' +
	'table#entities tbody {display: block; max-height: 560px; overflow-y: scroll; width:  98%}' +
	'table#entities th:first-child, table#entities td:first-child { width: 200px; word-break: break-word }' +
	'table#entities th:nth-child(2), table#entities td:nth-child(2) { width: 150px; word-break: break-word }' +
	'table#entities th:nth-child(3), table#entities td:nth-child(3) { width: 100px; word-break: break-word }' +
	'table#entities th:nth-child(4), table#entities td:nth-child(4) { padding-right: 20px; width: 80px; word-break: break-word }' +
	'table#entities td.n { text-align: right }' +
	'table#metrics { padding: 2px; width: 100% }' +
	'table#metrics tr { width:  98%, display: table }' +
	'table#metrics th { border-top: 1px solid #bcba7d; border-bottom: 1px solid #bcba7d; text-align: left }' +
	'table#metrics thead, table#metrics tfoot {display: table; width: 98%}' +
	'table#metrics thead tr, table#metrics tfoot tr {display: block}' +
	'table#metrics tbody {display: block; max-height: 560px; overflow-y: scroll; width:  98%}' +
	'table#metrics tfoot {display: block; max-height: 80px; overflow-y: scroll; width:  98%}' +
	'table#metrics th:first-child, table#metrics td:first-child { width: 200px; word-break: break-word }' +
	'table#metrics th:nth-child(2), table#metrics td:nth-child(2) { width: 150px; word-break: break-word }' +
	'table#metrics th:nth-child(3), table#metrics td:nth-child(3) { width: 100px; word-break: break-word }' +
	'table#metrics th:nth-child(4), table#metrics td:nth-child(4) { padding-right: 20px; width: 80px; word-break: break-word }' +
	'table#metrics td { text-align: right }' +
	'table#metrics td:first-child { text-align: left }' +
	'</style></head><body>';

if (mediaType == 'video/mp4') {

	header += '<video controls id="vplayr">' +
		`<source src="${mediaFile}" type="${mediaType}">` +
			`<track kind ="subtitles" label="English" srclang="en-us" src="${mediaFile.substring(0, mediaFile.length - 4)}_en.vtt">` +
			`<track kind ="subtitles" label="Spanish" srclang="es" src="${mediaFile.substring(0, mediaFile.length - 4)}_es.vtt">` +
			/*
			`<track kind ="subtitles" label="Portuguese" srclang="pt" src="${mediaFile.substring(0, mediaFile.length - 4)}_pt.vtt">` +
			`<track kind ="subtitles" label="French" srclang="fr" src="${mediaFile.substring(0, mediaFile.length - 4)}_fr.vtt">` +
			`<track kind ="subtitles" label="German" srclang="de" src="${mediaFile.substring(0, mediaFile.length - 4)}_de.vtt">` +
			`<track kind ="subtitles" label="Chinese (Simplified)" srclang="zh" src="${mediaFile.substring(0, mediaFile.length - 4)}_zh.vtt">` +
			`<track kind ="subtitles" label="Arabic" srclang="ar" src="${mediaFile.substring(0, mediaFile.length - 4)}_ar.vtt">` +
			*/
			'This browser does not seem to support the video element.' +
		'</video>' +
		'<script language="JavaScript">' +
		'var mediaPlayerElem = document.getElementById(\'vplayr\');' +
		'function setTimeIndex(timeIndex) {' +
		'	mediaPlayerElem.currentTime = timeIndex;' +
		'	if (mediaPlayerElem.paused) {' +
		'		mediaPlayerElem.play();' +
		'	}' +
		'}' +
		'</script>';

} else {

	header += '<audio controls id="aplayr">' +
		`<source src="${mediaFile}" type="${mediaType}">` +
			'This browser does not seem to support the audio element.' +
		'</audio>' +
		'<script language="JavaScript">' +
		'var mediaPlayerElem = document.getElementById(\'aplayr\');' +
		'function setTimeIndex(timeIndex) {' +
		'	mediaPlayerElem.currentTime = timeIndex;' +
		'	if (mediaPlayerElem.paused) {' +
		'		mediaPlayerElem.play();' +
		'	}' +
		'}' +
		'</script>';
}

// use comprehend to work with the NLP chunks
for (let i=0; (i < nlpChunks.length); i++) {

	// console.error(nlpChunks[i].text);
	waitOnTokens(500,
		function() {
			Comprehend.detectEntities({LanguageCode: 'en', Text:  nlpChunks[i].text},
				function(err, entities) {

					if (err) {
						console.error('Comprehend.detectEntities failed');
						console.error(JSON.stringify(err));
						returnToken();
						throw err;

					} else {

						// console.error(JSON.stringify(entities));
						nlpChunks[i].entities = entities.Entities;
						// make sure we return the token
						returnToken();
					}
				});
		});
}

// when all the Comprehend responses are available, start writing out the translated SRT
waitOnAllReturned(3000, function() {

	console.log(header);
	console.log('<div id="container"><div id="transcript">');
	console.log(result);
	console.log('</div><div id="nlp">');
	console.log('<table id="entities"><thead><tr><th>Entity</th><th>Type</th><th>Max Confidence</th><th>Count</th></tr></thead><tbody>');

	let entities = {};
	for (let i=0; (i < nlpChunks.length); i++) {

		for (let j=0; (j < nlpChunks[i].entities.length); j++) {

			let e = nlpChunks[i].entities[j];
			// ignore all quantities
			if ((e.Type != 'QUANTITY') && (e.Score > 0.5)) {

				let key = e.Type + '-' + e.Text;
				if (entities[key]) {

					// add to existing entry
					entities[key].Count++;
					if (entities[key].MaxScore < e.Score) {

						entities[key].MaxScore = e.Score;
					}

				} else {

					// add a new entry
					entities[key] = { Type: e.Type, Text: e.Text,  MaxScore: e.Score, Count: 1};
				}
			}

		}
		// console.log(JSON.stringify(nlpChunks[i].entities));
	}

	let entityKeys = Object.keys(entities);
	entityKeys.sort();
	for (let i=0; (i < entityKeys.length); i++) {

		let e = entities[entityKeys[i]];
		console.log(`<tr><td>${e.Text}</td><td>${e.Type}</td><td class="n">${Math.round(e.MaxScore * 100) / 100}</td><td class="n">${e.Count}</td></tr>`);
	}
	console.log('</tbody></table>');

	// write out the 10-second metrics
	console.log('<table id="metrics"><thead><tr><th>Index</th><th>Avg. Confidence</th><th>Terms</th><th>Unsure</th></tr></thead><tbody>');
	let termCount = 0, unsureTermCount = 0;
	metrics.forEach((e, i) => {

		console.log(`<tr><td>${e.timeIndex}</td><td>${Math.round((e.confidenceSum / e.termCount) * 100) / 100}</td><td>${e.termCount}</td><td>${e.unsureTermCount}</td></tr>`);
		termCount += e.termCount;
		unsureTermCount += e.unsureTermCount;
	});
	console.log(`</tbody><tfoot><tr><td></td><td>${(Math.round((unsureTermCount / termCount) * 10000) / 100)}% unsure</td><td>${termCount}</td><td>${unsureTermCount}</td></tr></tfoot></table>`);

	console.log('</div></div></body></html>');
});

const hdhr = require('hdhomerun');
const request = require('request-promise');
const Blue = require('bluebird');
const devnull = require('dev-null');
const ffmpeg = require('fluent-ffmpeg');
const async = require('async');
const fs = require('fs');
const chans = require('../channels.json');
const debug = require('debug')('ism:lib:c-c-l');
const d23 = '13264E94';
const d24 = '1323C1DC';

hdhr.discover(function (err, res) {
	if (err) throw new Error('discover error');

	res.forEach(function (dev) {
		debug('hdhomerun device %s found at %s',
			dev.device_id, dev.device_ip);
	});
	
	var device23 = hdhr.create(res[1]);
	var device24 = hdhr.create(res[0]);
	
	Blue.promisifyAll(device23, { suffix: 'P' });
	Blue.promisifyAll(device24, { suffix: 'P' });
	
	var deviceURL = "http://cablecard/lineup.json?show=unprotected";
	
	let pool = [1,2,5,4,0,3];
	let Channels = [];
	let missed = 0;
	let have = {}
	let got = chans.filter( v => { if (v.freq == '') { return true } else { have[v.channel] = v; return false}}).map(v => v.channel);
	debug('got', got);
	request({
		method: 'get',
		uri: deviceURL, 
		json: true
	})
	.then(channels => {
		async.eachOfLimit(channels, 5, ( c, k, cb ) => {
			if( got.indexOf(c.GuideNumber) == -1 ) {
				debug('Skip: ', c.GuideNumber);
				Channels.push(have[c.GuideNumber]);
				return cb();
			}
			probe(c, k, (res = {}) => {
				if ( res.freq == '' ) {
					debug('##########################################');
					debug('###  No Frequency... Redo  '+c.GuideNumber+'        ###');
					debug('##########################################');
					c.redo = true;
					probe( c, k, (res1) => { 
						if ( res.freq == '' ) {
							missed++;
						}
						Channels.push(res1);
						cb(); 
					});
				} else {
					Channels.push(res);
					cb()
				}
			});
			
		}, function (err) {
			debug("the Channels array was created", Channels.length);
			const filename = 'channels.json';
			let str = JSON.stringify(Channels, null, 4);
			str = str;			

			fs.writeFile(filename, str, function(err){
				if(err) {
					debug(err)
				} else {
					debug('File written!');
					debug('##########################################');
					debug('###  Error for  '+missed+'  channels       ###');
					debug('##########################################');
					process.exit(0);
				}
			});
		});
		
	})
	.catch(function( e ) {
		debug('FAIL:', e)
	});
	
	function setData(command, tuner, kill, device, info, key, cb2) {
		
			device.getP('/' + tuner + '/channel')
			.then(r => {
				info.freq = r.value.substr(4);
				//debug( info.freq);
				return device.getP('/' + tuner + '/program');
			})
			.then(r => {
				info.program = r.value;
				//debug( info.program);
				//stop ffmpeg
				return r
			})
			.then(r => {
				clearTimeout(kill);
				
					if(command) command.kill();
					debug('#####################################');
					debug('## SAVED ##','Pool:', key );
					debug(info);
					pool.unshift(key);
					cb2(info);
				
			})
			.catch(e => {
				debug('ERROR', e);
			});
		
	}
	function probe( c, k, cb1 ) {
		//tune the channel via the hhtp address so we cna query the unit
			const key = pool.pop();
			let tuner = 'tuner' + ( key%3 );
			let address = ( key > 2 ) ? 'cablecard2' : 'cablecard';
			let device = ( key > 2 ) ? device24 : device23;
			let info = { 
				name: c.GuideName,
				channel: c.GuideNumber,
				video: c.VideoCodec,
				audio: c.AudioCodec,
				hd: c.HD == true,
				auto: c.URL,
				favorite: c.Favorite == true,
				tuners: [
					'http://cablecard:5004/tuner0/v' + c.GuideNumber,
					'http://cablecard:5004/tuner1/v' + c.GuideNumber,
					'http://cablecard:5004/tuner2/v' + c.GuideNumber,
					'http://cablecard2:5004/tuner0/v' + c.GuideNumber,
					'http://cablecard2:5004/tuner1/v' + c.GuideNumber,
					'http://cablecard2:5004/tuner2/v' + c.GuideNumber,
				],
				verified: c.URL.replace('auto', tuner).replace('10.2.2.23', address) + '?ClientID=' + key + '&SessionID=' + k
			};
			let kill;
			//debug('channel run ffmpeg', c);
			const command = ffmpeg(info.verified).format('mpegts')
			.on('start', function(commandLine) {
				//debug('Spawned Ffmpeg with command: ' + commandLine);
				kill = setTimeout(function(){
					//command.kill();
					debug('#####################################');
					debug('#### NO CHANNEL                  ####');
					debug('#### Pool:'+ key + '             ####');
					debug('#### '+ c.GuideNumber + '            ####');
					debug('#####################################');
					debug('');
					setData(command, tuner, kill, device, info, key, cb1);
				}, c.redo ? 15000 : 10000);
			})
			.on('error', function(err) {
				//debug(err.message);
			})
			.on('end', function() {
				debug('Processing finished !');
			});
			
			let a = 1;
			const ffstream = command.pipe();
			ffstream.on('data', function(d) {
				//debug('ffmpeg sent data');
				a++;
				if(a===2) {
					setData(command, tuner, kill, device, info, key, cb1);
				}
			});
		
	}
	
});

	


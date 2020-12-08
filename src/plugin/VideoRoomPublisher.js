const LeaveCapability = require('./LeaveCapability');

class VideoRoomPublisher extends LeaveCapability {
  constructor (logger) {
    super(logger);
    this.pluginName = 'janus.plugin.videoroom';

    this.roomId = undefined;
    this.memberId = undefined;
    this.privateMemberId = undefined;

    this.offerSdp = undefined;
    this.answerSdp = undefined;
  }

  initialize (peerConnection) {
    this.peerConnection = peerConnection;
  }
  
  joinRoomAndPublish (roomId, displayName, roomPin = null,
      audio = true, video = true, data = true) {
    console.log(`Connecting to the room ${roomId}`);
    this.roomId = roomId;

    const body = {
      request: 'joinandconfigure',
      room: this.roomId,
      ptype: 'publisher',
      display: displayName,
      audio: audio,
      video: video,
      data: data,
    };

    if (roomPin) {
      body.pin = roomPin;
    }
    
    if (data) {
        this.dataChannel = this.peerConnection.createDataChannel("JanusDataChannel", { ordered: false });

        this.dataChannel.onmessage = (event) => {
          console.warn("Received an unexpected message on data channel", event);
        };

        let onDataChannelStateChange = (event) => {
          console.log("Received state change on data channel", event);
        };
        this.dataChannel.onopen = onDataChannelStateChange;
        this.dataChannel.onclose = onDataChannelStateChange;

        this.dataChannel.onerror = (error) => {
          console.error("Got an error on data channel", error);
        };
    }

    return this.peerConnection.createOffer({})
      .then((offer) => {
        console.log("SDP offer initialized");

        return this.peerConnection.setLocalDescription(offer)
          .then(() => {
            console.log('[pub] LocalDescription set', offer);
            const jsep = offer;
            if (this.filterDirectCandidates && jsep.sdp) {
              jsep.sdp = this.sdpHelper.filterDirectCandidates(jsep.sdp);
            }
            this.offerSdp = jsep.sdp;

            return this.transaction('message', { body, jsep }, 'event')
              .then((response) => {
                console.log(response);

                const { data, json } = response || {};
                if (!data || !data.id || !data.private_id || !data.publishers) {
                  this.logger.error('VideoRoom, could not join room', data);
                  throw new Error('VideoRoom, could not join room');
                }
                if (!json.jsep) {
                  throw new Error('Lacking JSEP field in response');
                }

                this.memberId = data.id;
                this.displayName = displayName;
                this.privateMemberId = data.private_id;

                const jsep = json.jsep;
                if (this.filterDirectCandidates && jsep.sdp) {
                  jsep.sdp = this.sdpHelper.filterDirectCandidates(jsep.sdp);
                }
                this.answerSdp = jsep.sdp;

                return this.peerConnection.setRemoteDescription(jsep)
                  .then(() => {
                    console.log("[pub] RemoteDescription set", jsep);

                    this.audioOn = audio;
                    this.videoOn = video;
                    return data.publishers;
                  })
              }).catch((error) => {
                this.logger.error('VideoRoom, error connecting to room', error);
                throw error;
              });
            });
          })
  }

  modifyPublishing (audio = true, video = true, data = true) {
    console.log(`Modifying publishing for member ${this.memberId} in room ${this.roomId}`);

    let configure = {
      request: 'configure',
      video: video,
      audio: audio,
      data: data
    };
    if (this.roomPin) {
      configure.pin = this.roomPin;
    }

    return this.transaction("message", { body: configure }, "event")
      .then((response) => {
        const { data, json } = response || {};

        if (!data || data.configured !== "ok") {
          this.logger.error("VideoRoom configure answer is not \"ok\"", data, json);
          throw new Error("VideoRoom configure answer is not \"ok\"");
        }

        console.log("Publishing modified", response);
        this.audioOn = audio;
        this.videoOn = video;
      }).catch((error) => {
        this.logger.error("VideoRoom, unknown error modifying publishing", error, configure);
        throw error;
      });
  }

  sendData (message){
    if (this.dataChannel) {
      console.log("Sending some data ", message);
      this.dataChannel.send(message);
    } else {
      console.error("Failed to send data over the DataChannel", this.dataChannel);
    }
  }

  stopAudio () {
    if (this.audioOn) {
      console.log("Stopping published audio");
      return this.modifyPublishing(false, this.videoOn);
    } else {
      console.log(`Published audio is already turned off`);
    }
  }

  startAudio () {
    if (!this.audioOn) {
      console.log("Starting published audio");
      return this.modifyPublishing(true, this.videoOn);
    } else {
      console.log(`Published audio is already turned on`);
    }
  }

  stopVideo () {
    if (this.videoOn) {
      console.log("Stopping published video");
      return this.modifyPublishing(this.audioOn, false);
    } else {
      console.log(`Published video is already turned off`);
    }
  }

  startVideo () {
    if (!this.videoOn) {
      console.log("Starting published video");
      return this.modifyPublishing(this.audioOn, true);
    } else {
      console.log(`Video of publisher ${this.publisherId} is already turned on`);
    }
  }

  onmessage (data, json) {
    // TODO data.videoroom === 'destroyed' handling
    // TODO unpublished === 'ok' handling : we are unpublished

    const { videoroom } = data || {};

    if (!data || !videoroom) {
      this.logger.error('VideoRoom got unknown message', json);
      return;
    }

    if (videoroom === 'slow_link') {
      this.logger.debug('VideoRoom got slow_link', data);
      this.slowLink(data);
      return;
    }

    if (videoroom === 'event') {
      const { room, joining, unpublished, leaving, publishers } = data;
      if (room !== this.roomId) {
        this.logger.error('VideoRoom got unknown roomId', this.roomId, json);
        return;
      }

      if (joining) {
        this.emit('remoteMemberJoined', joining);
      } else if (unpublished) {
        this.emit('remoteMemberUnpublished', unpublished);
      } else if (leaving) {
        this.emit('remoteMemberLeaving', leaving);
      } else if (Array.isArray(publishers)) {
        this.emit('publishersUpdated', publishers);
      } else {
        this.logger.error('VideoRoom got unknown event', json);
      }

      return;
    }

    this.logger.error('VideoRoom unhandled message:', videoroom, json);
  }
}

module.exports = VideoRoomPublisher;

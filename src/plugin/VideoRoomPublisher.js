const JanusPlugin = require('../JanusPlugin');

class VideoRoomPublisher extends JanusPlugin {
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
      relayAudio = true, relayVideo = true) {
    console.log(`Connecting to the room ${roomId}`);
    this.roomId = roomId;

    const body = {
      request: 'joinandconfigure',
      room: this.roomId,
      ptype: 'publisher',
      display: displayName,
      audio: relayAudio,
      video: relayVideo,
      data: false
    };

    if (roomPin) {
      body.pin = roomPin;
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
                this.privateMemberId = data.private_id;

                const jsep = json.jsep;
                if (this.filterDirectCandidates && jsep.sdp) {
                  jsep.sdp = this.sdpHelper.filterDirectCandidates(jsep.sdp);
                }
                this.answerSdp = jsep.sdp;

                return this.peerConnection.setRemoteDescription(jsep)
                  .then(() => {
                    console.log("[pub] RemoteDescription set", jsep);
                    return data.publishers;
                  })
              }).catch((error) => {
                this.logger.error('VideoRoom, error connecting to room', error);
                throw error;
              });
            });
          })
  }

  modifyPublishing (audio = true, video = true) {
    console.log(`Modifying publishing for member ${this.memberId} in room ${this.roomId}`);

    this.audio = audio;
    this.video = video;

    let configure = {
      request: 'configure',
      video: video,
      audio: audio,
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
      }).catch((error) => {
        this.logger.error("VideoRoom, unknown error modifying publishing", error, configure);
        throw error;
      });
  }

  stopAudio () {
    console.log("Stopping published audio");
    return this.modifyPublishing(false, this.video);
  }

  startAudio () {
    console.log("Starting published audio");
    return this.modifyPublishing(true, this.video);
  }

  stopVideo () {
    console.log("Stopping published video");
    return this.modifyPublishing(this.audio, false);
  }

  startVideo () {
    console.log("Starting published video");
    return this.modifyPublishing(this.audio, true);
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
      this.slowLink();
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

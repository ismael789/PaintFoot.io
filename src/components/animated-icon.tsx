import { Palette } from "@/constants/palette";
import { Image } from 'expo-image';
import * as SplashScreen from 'expo-splash-screen';
import { useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { Easing, Keyframe } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

const DURATION = 600;

export function AnimatedSplashOverlay() {
  const [animate, setAnimate] = useState(false);
  const [visible, setVisible] = useState(true);

  if (!visible) return null;

  const splashKeyframe = new Keyframe({
    0: {
      transform: [{ scale: 1 }],
      opacity: 1,
    },
    20: {
      opacity: 1,
    },
    70: {
      opacity: 0,
      easing: Easing.elastic(0.7),
    },
    100: {
      opacity: 0,
      transform: [{ scale: 1 }],
      easing: Easing.elastic(0.7),
    },
  });

  const image = <Image style={styles.image} source={require('@/assets/images/expo-logo.png')} />;

  return animate ? (
    <Animated.View
      entering={splashKeyframe.duration(DURATION).withCallback((finished) => {
        'worklet';
        if (finished) {
          scheduleOnRN(setVisible, false);
        }
      })}
      style={styles.splashOverlay}>
      {image}
    </Animated.View>
  ) : (
    <View
      onLayout={() => {
        SplashScreen.hideAsync().finally(() => {
          setAnimate(true);
        });
      }}
      style={styles.splashOverlay}>
      {image}
    </View>
  );
}

const logoKeyframe = new Keyframe({
  0: {
    transform: [{ scale: 1.3 }],
    opacity: 0,
  },
  40: {
    transform: [{ scale: 1.3 }],
    opacity: 0,
    easing: Easing.elastic(0.7),
  },
  100: {
    opacity: 1,
    transform: [{ scale: 1 }],
    easing: Easing.elastic(0.7),
  },
});

const glowKeyframe = new Keyframe({
  0: {
    transform: [{ rotateZ: '0deg' }],
  },
  100: {
    transform: [{ rotateZ: '7200deg' }],
  },
});

export function AnimatedIcon() {
  const { width, height } = useWindowDimensions();
  const iconSize = Math.max(96, Math.min(128, width * 0.34));
  const initialScale = Math.max(4, height / Math.max(iconSize, 1));
  const keyframe = new Keyframe({
    0: { transform: [{ scale: initialScale }] },
    100: { transform: [{ scale: 1 }], easing: Easing.elastic(0.7) },
  });

  return (
    <View style={[styles.iconContainer, { width: iconSize, height: iconSize }]}>
      <Animated.View
        entering={glowKeyframe.duration(60 * 1000 * 4)}
        style={[styles.glow, { width: iconSize * 1.57, height: iconSize * 1.57 }]}
      >
        <Image
          style={[styles.glow, { width: iconSize * 1.57, height: iconSize * 1.57 }]}
          source={require('@/assets/images/logo-glow.png')}
        />
      </Animated.View>

      <Animated.View
        entering={keyframe.duration(DURATION)}
        style={[styles.background, { width: iconSize, height: iconSize }]}
      />
      <Animated.View style={styles.imageContainer} entering={logoKeyframe.duration(DURATION)}>
        <Image
          style={[styles.image, { width: iconSize * 0.594, height: iconSize * 0.555 }]}
          source={require('@/assets/images/expo-logo.png')}
        />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  imageContainer: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  glow: {
    position: 'absolute',
  },
  iconContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 100,
  },
  image: {
  },
  background: {
    borderRadius: 40,
    experimental_backgroundImage: `linear-gradient(180deg, ${Palette.sky400}, ${Palette.navy500})`,
    position: 'absolute',
  },
  splashOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: Palette.sky500,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
});

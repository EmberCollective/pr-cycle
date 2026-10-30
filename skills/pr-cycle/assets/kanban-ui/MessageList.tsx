import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  type ForwardedRef,
  type Key,
  type ReactElement,
  type ReactNode,
  type RefAttributes,
} from 'react';
import { Virtuoso, type Components, type VirtuosoHandle } from 'react-virtuoso';

type ItemLocation = {
  index: number | 'LAST';
  align?: 'start' | 'center' | 'end';
  behavior?: 'auto' | 'smooth';
};

export type ScrollModifier =
  | { type: 'item-location'; location: ItemLocation; purgeItemSizes?: boolean }
  | { type: 'auto-scroll-to-bottom'; autoScroll: 'auto' | 'smooth' };

export interface DataWithScrollModifier<T> {
  data: T[];
  scrollModifier: ScrollModifier;
}

export interface MessageListMethods<T> {
  scrollToItem: (location: ItemLocation) => void;
  data: { getCurrentlyRendered: () => T[] };
}

export interface MessageListProps<T, C> {
  data: DataWithScrollModifier<T> | null;
  context: C;
  className?: string;
  initialLocation?: ItemLocation;
  computeItemKey: (item: { data: T; index: number; context: C }) => Key;
  ItemContent: (item: { data: T; index: number; context: C }) => ReactNode;
  Header?: Components<T, C>['Header'];
  Footer?: Components<T, C>['Footer'];
}

// Only the conversation behaviors used by the pinned frontend are adapted here.
// Virtualization and dynamic row measurement come from MIT react-virtuoso.
function MessageListInner<T, C>(
  {
    data,
    context,
    className,
    initialLocation,
    computeItemKey,
    ItemContent,
    Header,
    Footer,
  }: MessageListProps<T, C>,
  ref: ForwardedRef<MessageListMethods<T>>
) {
  const listRef = useRef<VirtuosoHandle>(null);
  const renderedRef = useRef<T[]>([]);
  const atBottomRef = useRef(true);
  const rows = data?.data ?? [];
  const autoFollow = data?.scrollModifier.type === 'auto-scroll-to-bottom';
  const components = useMemo(() => ({ Header, Footer }), [Header, Footer]);

  useImperativeHandle(ref, () => ({
    scrollToItem: (location) => listRef.current?.scrollToIndex(location),
    data: { getCurrentlyRendered: () => renderedRef.current },
  }));

  useLayoutEffect(() => {
    if (!data?.data.length) {
      renderedRef.current = [];
      atBottomRef.current = true;
      return;
    }
    const modifier = data.scrollModifier;
    if (modifier.type !== 'item-location') return;
    const frame = requestAnimationFrame(() => {
      listRef.current?.scrollToIndex(modifier.location);
    });
    return () => cancelAnimationFrame(frame);
  }, [data]);

  return (
    <Virtuoso<T, C>
      ref={listRef}
      className={className}
      style={{ height: '100%', minHeight: 0 }}
      data={rows}
      context={context}
      initialTopMostItemIndex={initialLocation}
      computeItemKey={(index, item) =>
        computeItemKey({ index, data: item, context })
      }
      itemContent={(index, item) => (
        <ItemContent index={index} data={item} context={context} />
      )}
      components={components}
      alignToBottom
      atBottomThreshold={48}
      atBottomStateChange={(atBottom) => {
        atBottomRef.current = atBottom;
      }}
      followOutput={(atBottom) => (autoFollow && atBottom ? 'auto' : false)}
      totalListHeightChanged={() => {
        if (autoFollow && atBottomRef.current) {
          listRef.current?.autoscrollToBottom();
        }
      }}
      itemsRendered={(items) => {
        renderedRef.current = items
          .map((item) => item.data)
          .filter((item): item is T => item !== undefined);
      }}
    />
  );
}

export const MessageList = forwardRef(MessageListInner) as <T, C>(
  props: MessageListProps<T, C> & RefAttributes<MessageListMethods<T>>
) => ReactElement;

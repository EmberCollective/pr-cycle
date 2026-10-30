import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  MessageList,
  type DataWithScrollModifier,
  type MessageListMethods,
  type MessageListProps,
} from "./MessageList";

interface Row {
  id: number;
  text: string;
}
const initial = {
  type: "item-location" as const,
  location: { index: "LAST" as const, align: "end" as const },
};
const follow = {
  type: "auto-scroll-to-bottom" as const,
  autoScroll: "smooth" as const,
};
const rows = () =>
  Array.from({ length: 200 }, (_, id) => ({ id, text: `Message ${id}` }));
const Item: MessageListProps<Row, string>["ItemContent"] = ({
  data,
  context,
}) => (
  <div
    data-row={data.id}
    style={{
      minHeight: 72,
      whiteSpace: "pre-wrap",
      borderBottom: "1px solid #ccc",
    }}
  >
    {context}: {data.text}
  </div>
);
const itemKey: MessageListProps<Row, string>["computeItemKey"] = ({ data }) =>
  data.id;

function Harness() {
  const [data, setData] = useState<DataWithScrollModifier<Row> | null>(null);
  const [context, setContext] = useState("conversation");
  const [visible, setVisible] = useState("");
  const ref = useRef<MessageListMethods<Row>>(null);
  return (
    <>
      <button
        onClick={() => setData({ data: rows(), scrollModifier: initial })}
      >
        Load
      </button>
      <button onClick={() => setData(null)}>Clear</button>
      <button
        onClick={() =>
          setData((old) => ({
            data: [
              ...(old?.data ?? []),
              { id: old?.data.length ?? 0, text: "Appended" },
            ],
            scrollModifier: follow,
          }))
        }
      >
        Append
      </button>
      <button
        onClick={() =>
          setData((old) => ({
            data: (old?.data ?? []).map((row, i, all) =>
              i === all.length - 1
                ? { ...row, text: row.text + "\nstreamed line".repeat(20) }
                : row,
            ),
            scrollModifier: follow,
          }))
        }
      >
        Stream
      </button>
      <button
        onClick={() =>
          ref.current?.scrollToItem({ index: 50, align: "center" })
        }
      >
        Search
      </button>
      <button
        onClick={() =>
          ref.current?.scrollToItem({
            index: "LAST",
            align: "end",
            behavior: "smooth",
          })
        }
      >
        Bottom
      </button>
      <button
        onClick={() =>
          setVisible(
            ref.current?.data
              .getCurrentlyRendered()
              .map((r) => r.id)
              .join(",") ?? "",
          )
        }
      >
        Visible
      </button>
      <button onClick={() => setContext("search match")}>Context</button>
      <output>{visible}</output>
      <div style={{ height: 400, width: 640 }}>
        <MessageList
          ref={ref}
          data={data}
          context={context}
          ItemContent={Item}
          computeItemKey={itemKey}
          initialLocation={initial.location}
        />
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);

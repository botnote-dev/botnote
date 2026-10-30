import { Button } from "@cloudflare/kumo/components/button";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { SortAscendingIcon } from "@phosphor-icons/react";
import { TASK_GROUP_LABEL, TASK_SORT_LABEL, type TaskGroup, type TaskSort } from "./sorting";

export function ViewOptionsMenu({
  sort,
  setSort,
  group,
  setGroup
}: {
  sort: TaskSort;
  setSort: (s: TaskSort) => void;
  group?: TaskGroup;
  setGroup?: (g: TaskGroup) => void;
}) {
  const label = group
    ? `${TASK_GROUP_LABEL[group]} · ${TASK_SORT_LABEL[sort]}`
    : TASK_SORT_LABEL[sort];
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button
            size="sm"
            icon={<SortAscendingIcon size={14} className="text-kumo-subtle" />}
            aria-label={`View options: ${label}`}
          >
            <span className="hidden sm:inline">{label}</span>
          </Button>
        }
      />
      <DropdownMenu.Content align="end" className="w-48">
        {group && setGroup && (
          <>
            <DropdownMenu.Group>
              <DropdownMenu.Label>Group by</DropdownMenu.Label>
              <DropdownMenu.RadioGroup value={group} onValueChange={(g) => setGroup(g as TaskGroup)}>
                {(Object.keys(TASK_GROUP_LABEL) as TaskGroup[]).map((g) => (
                  <DropdownMenu.RadioItem key={g} value={g} closeOnClick>
                    <span>{TASK_GROUP_LABEL[g]}</span>
                    <DropdownMenu.RadioItemIndicator />
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
            </DropdownMenu.Group>
            <DropdownMenu.Separator />
          </>
        )}
        <DropdownMenu.Group>
          <DropdownMenu.Label>Sort by</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={sort} onValueChange={(s) => setSort(s as TaskSort)}>
            {(Object.keys(TASK_SORT_LABEL) as TaskSort[]).map((s) => (
              <DropdownMenu.RadioItem key={s} value={s} closeOnClick>
                <span>{TASK_SORT_LABEL[s]}</span>
                <DropdownMenu.RadioItemIndicator />
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Group>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}
